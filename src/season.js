// ============================================================================
// TEMPORADA: foto do placar final e estado OFF-SEASON.
//
// O placar ao vivo é recalculado da presença bruta (voice_presence). A "foto"
// grava o resultado no fechamento da temporada numa tabela própria
// (season_results), então o resultado oficial NÃO depende mais da retenção
// dos dados brutos e nunca muda depois de tirado.
//
// Fora de temporada (OFF-SEASON): o placar do canal mostra a foto da última
// temporada encerrada até que uma nova comece com /cta_start_temporada.
// ============================================================================

const HEAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // só "cura" foto de temporada encerrada recentemente

// Calcula o placar da janela da temporada. Usado pela foto E pelo ensaio, para
// que o ensaio nunca mostre algo diferente do que seria salvo.
async function computeStandings(attendance, guildId, season, endOverride) {
  const start = new Date(season.started_at);
  const end = endOverride || (season.ended_at ? new Date(season.ended_at) : new Date());
  const report = await attendance.buildReport(guildId, start, end);
  const standings = report.rows
    .filter((r) => r.integral + r.parcial + r.rapida > 0 || r.fantasma > 0)
    .map((r) => ({
      user_id: r.user_id,
      username: r.username,
      integral: r.integral,
      parcial: r.parcial,
      rapida: r.rapida,
      fantasma: r.fantasma,
      bomb: r.bomb,
      pingou: r.pingou,
      minutos: r.minutos,
      score: r.score,
      cat: r.cat,
    }));
  return { start, end, ctaCount: report.ctaCount, standings };
}

// Tira a foto: calcula o placar da janela da temporada e grava (permanente).
// db e attendance entram por parâmetro para o módulo ser testável isoladamente.
async function snapshotSeason(db, attendance, guildId, season, endOverride) {
  const { start, end, ctaCount, standings } = await computeStandings(attendance, guildId, season, endOverride);
  return db.saveSeasonResults({
    guildId,
    seasonId: season.id,
    number: season.number,
    startedAt: start,
    endedAt: end,
    ctaCount,
    standings,
  });
}

// ENSAIO do fechamento: calcula exatamente o que a foto salvaria, mas NÃO grava
// nada (não toca em season_results nem no canal de ranking). Serve para medir
// o tempo e conferir o resultado antes do /cta_finish_temporada de verdade.
async function previewSeason(attendance, guildId, season, endOverride) {
  const t0 = Date.now();
  const { start, end, ctaCount, standings } = await computeStandings(attendance, guildId, season, endOverride);
  const blocks = offSeasonBlocks({
    number: season.number,
    ended_at: end,
    cta_count: ctaCount,
    standings,
  });
  return {
    number: season.number,
    startedAt: start,
    endedAt: end,
    ctaCount,
    players: standings.length,
    standings,
    blocks: blocks.length,
    longestBlock: Math.max(...blocks.map((b) => b.length)),
    elapsedMs: Date.now() - t0,
  };
}

// Devolve a foto da última temporada encerrada. Se a temporada acabou há pouco
// e a foto não existe (falha no fechamento), tenta tirá-la agora.
async function lastSnapshotOrHeal(db, attendance, guildId) {
  const snap = await db.getLastSeasonResults(guildId);
  const ended = await db.getLastEndedSeason(guildId);

  // Só aceita uma foto se ela pertencer à temporada encerrada mais recente.
  // Caso contrário, mostrar uma foto antiga como se fosse o último resultado
  // seria pior do que informar que o placar final ainda não está disponível.
  if (!ended) return snap || null;
  if (snap && Number(snap.season_id) === Number(ended.id)) return snap;

  const endedAt = new Date(ended.ended_at).getTime();
  const canHeal = Number.isFinite(endedAt) && Date.now() - endedAt < HEAL_WINDOW_MS;
  if (canHeal) {
    try {
      return await snapshotSeason(db, attendance, guildId, ended);
    } catch (e) {
      console.error("lastSnapshotOrHeal:", e?.message || e);
    }
  }
  return null;
}

function standingLine(r, i, ctaCount) {
  return `\`${String(i + 1).padStart(3)}\` **${r.username}** · ${r.score} pts · ${r.integral + r.parcial}/${ctaCount} · ${r.cat}`;
}

// Mensagens do canal de ranking no OFF-SEASON (foto da última temporada).
function offSeasonBlocks(snap) {
  const standings = Array.isArray(snap.standings) ? snap.standings : [];
  const fim = Math.floor(new Date(snap.ended_at).getTime() / 1000);
  const header =
    `🏖️ **OFF-SEASON**\n` +
    `Temporada ${snap.number} encerrada em <t:${fim}:D>. A contagem de presença está pausada ` +
    `até uma nova temporada começar (**/cta_start_temporada**).\n\n` +
    `🏆 **RESULTADO FINAL · TEMPORADA ${snap.number}** (foto do fechamento)\n` +
    `${snap.cta_count} CTAs · ${standings.length} jogadores pontuando\n`;
  const blocks = [];
  let cur = header;
  standings.forEach((r, i) => {
    const l = standingLine(r, i, snap.cta_count);
    if ((cur + "\n" + l).length > 1900) { blocks.push(cur); cur = ""; }
    cur += (cur ? "\n" : "") + l;
  });
  if (cur.trim()) blocks.push(cur);
  return blocks.length ? blocks : [header + "\n_(ninguém pontuou nesta temporada)_"];
}

// Resposta do /cta_meurank no OFF-SEASON.
function offSeasonMyRank(snap, userId) {
  const standings = Array.isArray(snap.standings) ? snap.standings : [];
  const idx = standings.findIndex((r) => r.user_id === userId);
  if (idx === -1) {
    return `🏖️ **OFF-SEASON · Temporada ${snap.number}**\n\nVocê não pontuou na Temporada ${snap.number}. A próxima começa quando um Mestre de Guerra iniciar com **/cta_start_temporada**.`;
  }
  const r = standings[idx];
  return (
    `🏖️ **OFF-SEASON · Teu resultado final — Temporada ${snap.number}**\n\n` +
    `**Posição:** ${idx + 1}º de ${standings.length}\n` +
    `**Score:** ${r.score} pts\n` +
    `**Presença:** ${r.integral + r.parcial}/${snap.cta_count} CTAs\n` +
    `   • ${r.integral} integrais, ${r.parcial} parciais${r.rapida ? `, ${r.rapida} rápidas` : ""}\n` +
    `${r.fantasma ? `   • ⚠️ ${r.fantasma} fantasma(s) (pingou e não veio)\n` : ""}` +
    `**Categoria:** ${r.cat}`
  );
}

module.exports = { snapshotSeason, previewSeason, lastSnapshotOrHeal, offSeasonBlocks, offSeasonMyRank };
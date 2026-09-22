// ============================================================================
// CASTELO — conteúdo de guerra de castelo. 3 PTs:
//   PT1 = press comp (PARTIES[4])
//   PT2 = PT1 normal do CTA (PARTIES[0])
//   PT3 = PT2 normal do CTA (PARTIES[1])
// Sala de voz dinâmica + presença por tempo + divisão de prata (igual roaming).
// ============================================================================
const { PARTIES } = require("./comps");
const roaming = require("./roaming"); // reaproveita presenceMinutes e dividir

// mapeia as 3 PTs do castelo -> índices no PARTIES
const CASTELO_PT_INDEX = [4, 0, 1]; // PT1=press(4), PT2=cta pt1(0), PT3=cta pt2(1)

// devolve o slot real de uma PT do castelo (casteloPt 0,1,2 -> slot)
function casteloSlot(casteloPt, slotIndex) {
  const realIndex = CASTELO_PT_INDEX[casteloPt];
  if (realIndex == null) return null;
  return PARTIES[realIndex]?.slots[slotIndex] || null;
}
function casteloParty(casteloPt) {
  const realIndex = CASTELO_PT_INDEX[casteloPt];
  return PARTIES[realIndex] || null;
}
const NUM_CASTELO_PTS = CASTELO_PT_INDEX.length; // 3

// reusa a divisão de prata do roaming (proporcional ao tempo, >=10min, pingou)
const presenceMinutes = roaming.presenceMinutes;
const dividir = roaming.dividir;

module.exports = { CASTELO_PT_INDEX, NUM_CASTELO_PTS, casteloSlot, casteloParty, presenceMinutes, dividir };

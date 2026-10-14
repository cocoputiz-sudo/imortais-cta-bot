"use strict";

const assert = require("assert/strict");
const vm = require("node:vm");
const { once } = require("node:events");

process.env.PGSSL = "disable";
process.env.PORT = String(39000 + (process.pid % 1000));

const db = require("../src/db");
const telemetry = require("../src/telemetry");
const contributorWeekly = require("../src/contributorWeekly");
const contributorCycle = require("../src/contributorCycle");
const web = require("../src/web");

const G = process.env.GUILD_ID || "guild-test";

function ok(name) { console.log("✅ " + name); }

function cookieFor({ canEdit, canViewContributors=false, isSiteAdmin=false,
  canEditGuildMight=false, canEditContributors=false }) {
  const sid = web.__test.signSession({
    id: canEdit ? "staff-test" : "member-test",
    name: canEdit ? "Staff Test" : "Member Test",
    isMember: true,
    canEdit: !!canEdit,
    canViewContributors:!!canViewContributors,
    canEditGuildMight:!!canEditGuildMight,
    canEditContributors:!!canEditContributors,
    isSiteAdmin:!!isSiteAdmin,
    exp: Date.now() + 60 * 60 * 1000,
  });
  return "sid=" + sid;
}

async function post(base, cookie, body) {
  const response = await fetch(base + "/api/guild-roster/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify(body || {}),
  });
  const json = await response.json();
  return { status: response.status, json };
}

function testBrowserScriptSyntax() {
  const page = String(web.__test.PAGE || "");
  const match = /<script>([\s\S]*?)<\/script>/.exec(page);
  assert.ok(match && match[1], "script do navegador precisa existir no PAGE");
  new vm.Script(match[1], { filename: "war-room-browser.js" });
  ok("JavaScript do navegador em web.js tem sintaxe válida");
}

function testMobileAndMuralShell() {
  const page = String(web.__test.PAGE || "");
  assert.ok(page.includes('id="mobile-nav"'), "War Room mobile precisa manter menu de navegação");
  assert.ok(page.includes("overflow-x:hidden"), "shell mobile precisa impedir overflow horizontal da página");
  assert.ok(page.includes("100dvh"), "modais mobile precisam respeitar viewport dinâmica");
  assert.ok(page.includes("SepoDeMadeiraRs") && page.includes("VanWes"), "mural precisa manter vencedores do attendance");
  assert.ok(page.includes("IMORTAIS-Combat-Client-Setup-v0.6.0.exe"), "mural precisa manter download estável do Combat Client");
  assert.ok(page.includes("CTA War Room · central operacional da IMORTAIS"), "mural precisa manter card de funcionalidades do War Room");
  ok("War Room mobile e comunicados fixos do mural presentes");
}

async function seedRouteScenario() {
  await db.pool.query("TRUNCATE TABLE voice_presence, cta_signups, cta_events RESTART IDENTITY CASCADE");

  const ev = await db.createEvent({
    guildId: G,
    channelId: "guild-roster-route",
    callerId: "caller",
    timeLabel: "19:20",
    remind30: new Date(),
    remind10: new Date(),
  });

  for (const [uid, username, weapon] of [
    ["1", "[IM] Alfa", "JURADOR"],
    ["3", "[IM] Charlie", "ARCO LONGO"],
    ["6", "[IM] Foxtrot", "GOLEM"],
  ]) {
    await db.upsertSignup({
      eventId: ev.id,
      userId: uid,
      username,
      weapon,
      presence: "online",
      partyIndex: 0,
      slotIndex: 1,
    });
  }

  await db.pool.query(
    "INSERT INTO voice_presence(guild_id,user_id,username,channel_id,channel_kind,joined_at,left_at) VALUES " +
    "($1,'1','[IM] Alfa','guild-roster-route','prep',now()-interval '10 minutes',NULL)," +
    "($1,'2','[IM] Bravo','guild-roster-route','prep',now()-interval '10 minutes',NULL)",
    [G]
  );

  return ev;
}

async function testRouteAccessAndResponses() {
  const ev = await seedRouteScenario();
  const roster = [
    '"Character Name"\t"Last Seen"\t"Roles"',
    '"Alfa"\t"Online"\t""',
    '"Bravo"\t"Online"\t""',
    '"Charlie"\t"09/24/2026 00:10:00"\t""',
    '"Delta"\t"Online"\t"CONTRIBUINTE 1"',
    '"Golf"\t"Online"\t"Contribuinte 2"',
    '"Hotel"\t"Online"\t"CONTRIBUINTE 3"',
    '"Echo"\t"Online"\t""',
    '"Foxtrot"\t"Online"\t""',
  ].join("\n");

  const server = web.startWebServer(null, {});
  if (!server.listening) await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr === "object", "servidor de teste deve usar TCP local");
  const base = "http://127.0.0.1:" + addr.port;

  try {
    const member = await post(base, cookieFor({ canEdit: false }), { text: roster, eventId: ev.id });
    assert.equal(member.status, 403);
    assert.equal(member.json.error, "no_edit");

    const empty = await post(base, cookieFor({ canEdit: true }), { text: "", eventId: ev.id });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error, "empty");

    const missing = await post(base, cookieFor({ canEdit: true }), { text: roster, eventId: 999999 });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, "event_not_found");

    const beforeAnalysis=await contributorWeekly.rosterLatest(db.pool);
    const good = await post(base, cookieFor({ canEdit: true }), { text: roster, eventId: ev.id });
    assert.equal(good.status, 200);
    assert.equal(good.json.ok, true);
    assert.equal(good.json.savedRoster,undefined,"analisar nao pode alterar contribuintes");
    assert.deepEqual(await contributorWeekly.rosterLatest(db.pool),beforeAnalysis,
      "analise de Guilda Online jamais grava a lista");
    const requestImport=async(path,cookie,body)=>{
      const response=await fetch(base+"/api/contributors/roster/"+path,{
        method:"POST",headers:{"Content-Type":"application/json",Cookie:cookie},
        body:JSON.stringify(body||{})});
      return {status:response.status,json:await response.json()};
    };
    const adminCookie=cookieFor({canEdit:true,isSiteAdmin:true});
    const officerCookie=cookieFor({canEdit:false,canViewContributors:true});
    const editorCookie=cookieFor({canEdit:true});
    // Cargo Police da Guild: permitido APENAS editar Guild Might e Contribuintes.
    const policeRoleId="1392859981371412671";
    assert(web.__test.hasPoliceGuildRole([policeRoleId]));
    assert.equal(web.__test.hasPoliceGuildRole(["1392859981371412672"]),false,
      "somente o ID exato tem autorizacao");
    assert(web.__test.canEditGuildMight([policeRoleId],"police-test","Police"));
    assert(web.__test.canEditContributors([policeRoleId],"police-test","Police"));
    assert(web.__test.canViewContributors([policeRoleId],"police-test","Police"));
    assert.equal(web.__test.canEditContributors([],"member-test","Member"),false);
    const policeCookie=cookieFor({canEdit:false,canViewContributors:true,
      canEditGuildMight:true,canEditContributors:true});
    const policeSession=await fetch(base+"/auth/me",{headers:{Cookie:policeCookie}}).then(r=>r.json());
    assert.equal(policeSession.isSiteAdmin,false);
    assert.equal(policeSession.canEdit,false,"nao habilita edicao de CTA/War Room geral");
    assert.equal(policeSession.canManageDevices,false);
    assert.equal(policeSession.canManageBomb,false);
    assert.equal(policeSession.canEditGuildMight,true);
    assert.equal(policeSession.canEditContributors,true);
    assert.equal(policeSession.canViewContributors,true);
    assert.equal((await requestImport("preview",policeCookie,{text:roster})).status,200,
      "Police pode validar lista G em Contribuintes");
    assert.equal((await post(base,policeCookie,{text:roster,eventId:ev.id})).status,403,
      "Police nao ganha permissao para editar/analisar CTAs");
    assert.equal((await fetch(base+"/api/telemetry/guild-might-ingest-status",{
      headers:{Cookie:policeCookie}})).status,403,"diagnosticos sensiveis continuam admin-only");
    assert.equal((await requestImport("preview",editorCookie,{text:roster})).status,403,
      "editor nao deve atualizar cadastro sem ser administrador");
    assert.equal((await requestImport("confirm",officerCookie,{text:roster})).status,403,
      "officer nao pode confirmar importacao");
    const obsolete=await fetch(base+"/api/guild-roster/save",{
      method:"POST",headers:{"Content-Type":"application/json",Cookie:editorCookie},
      body:JSON.stringify({text:roster})});
    assert.equal(obsolete.status,410,"endpoint antigo nao deve gravar a lista");
    const preflight=await requestImport("preview",adminCookie,{text:roster});
    assert.equal(preflight.status,200,"admin pode previsualizar roster");
    assert.equal(preflight.json.memberCount,8);
    assert.deepEqual(preflight.json.groups["1"],["Delta"]);
    assert.deepEqual(preflight.json.groups["2"],["Golf"]);
    assert.deepEqual(preflight.json.groups["3"],["Hotel"]);
    assert.equal(await contributorWeekly.rosterLatest(db.pool),null,
      "previsualizar nao deve gravar no banco");
    assert.equal((await requestImport("confirm",adminCookie,{text:roster})).status,400,
      "sem previa, importacao recusada");
    assert.equal((await requestImport("confirm",adminCookie,{
      text:roster,checksum:preflight.json.checksum,
      expectedImportedAt:preflight.json.expectedImportedAt,previewedAt:preflight.json.previewedAt,
      previewToken:"0".repeat(64)})).status,400,"assinatura falsificada e recusada");
    assert.equal((await requestImport("confirm",adminCookie,{
      text:roster+"\\nALTERADO",checksum:preflight.json.checksum,
      expectedImportedAt:preflight.json.expectedImportedAt,previewedAt:preflight.json.previewedAt,
      previewToken:preflight.json.previewToken
    })).status,400,"texto diferente da previa e recusado");
    const initialConfirm=await requestImport("confirm",adminCookie,{
      text:roster,checksum:preflight.json.checksum,
      expectedImportedAt:preflight.json.expectedImportedAt,previewedAt:preflight.json.previewedAt,
      previewToken:preflight.json.previewToken});
    assert.equal(initialConfirm.status,200);
    assert.equal(initialConfirm.json.saved.contributors,3);
    // Police tem acesso ao mesmo fluxo protegido preview + confirmação que site-admin.
    const previewPolice=await requestImport("preview",policeCookie,{text:roster});
    assert.equal(previewPolice.status,200);
    const confirmPolice=await requestImport("confirm",policeCookie,{
      text:roster,checksum:previewPolice.json.checksum,
      expectedImportedAt:previewPolice.json.expectedImportedAt,previewedAt:previewPolice.json.previewedAt,
      previewToken:previewPolice.json.previewToken});
    assert.equal(confirmPolice.status,200,"Police pode confirmar importacao do G");
    const saved=await contributorWeekly.rosterLatest(db.pool);
    assert.equal(saved.members.length,8,"somente confirmacao grava no PostgreSQL");
    assert.equal(saved.members.find(x=>x.name==="Delta").roles[0],"CONTRIBUINTE 1");
    assert.equal(saved.import_source,"contributors_confirmed","novo registro possui origem auditavel");
    // Mesmo apos uma importacao, a analise de Guilda Online nao pode sobrescreve-la.
    const differentRoster=roster.replace("CONTRIBUINTE 1","CONTRIBUINTE 4");
    assert.equal((await post(base,editorCookie,{text:differentRoster,eventId:ev.id})).status,200);
    assert.deepEqual(await contributorWeekly.rosterLatest(db.pool),saved,
      "analise posterior nao pode modificar roster salvo");


    const contributorRead=async (cookie,method="GET",body=null)=>{
      const options={method,headers:{Cookie:cookie}};
      if(body){options.headers["Content-Type"]="application/json";options.body=JSON.stringify(body);}
      const response=await fetch(base+"/api/contributors/"+(method==="GET"?"weekly":"settings"),options);
      return {status:response.status,json:await response.json()};
    };
    assert.equal((await contributorRead(cookieFor({canEdit:false}))).status,403,
      "regular guild member cannot see contributor report");
    assert.equal((await contributorRead(cookieFor({canEdit:true}))).status,403,
      "a caller without admin/officer role cannot see contributor report");
    const policeReport=await contributorRead(policeCookie);
    assert.equal(policeReport.status,200,"Police pode abrir relatorio de contribuintes");
    const officerReport=await contributorRead(cookieFor({canEdit:false,canViewContributors:true}));
    assert.equal(officerReport.status,200,"officer can see contributor report");
    assert.equal(officerReport.json.roster.memberCount,8);
    assert.equal(officerReport.json.roster.source,"contributors_confirmed");
    assert.equal(officerReport.json.roster.importedBy,"member-test","importacao confirmada pela Police registra autor");
    assert.equal(officerReport.json.rows.length,3,"read only contributor roles 1, 2 and 3");
    const adminCfg={minima:{"1":{pve:10,gathering:5},"2":{pve:1,gathering:1},"3":{pve:1,gathering:1}},weekday:0,timeUtc:"18:00",reminderEnabled:false};
    assert.equal((await contributorRead(cookieFor({canEdit:false,canViewContributors:true}),"POST",adminCfg)).status,403,
      "officer cannot alter the thresholds or schedule");
    assert.equal((await contributorRead(cookieFor({canEdit:true,isSiteAdmin:true}),"POST",adminCfg)).status,200,
      "site admin can update contributor minimums");
    const storedSettings=await contributorWeekly.getSettings(db.pool);
    assert.equal(storedSettings.minima["1"].pve,10);
    assert.equal(storedSettings.reminderEnabled,false);
    const policeConfig=await contributorRead(policeCookie,"POST",adminCfg);
    assert.equal(policeConfig.status,200,"Police pode salvar os mesmos limites e lembretes que o admin");
    const progressApi=base+"/api/telemetry/guild-progress";
    async function postProgress(cookie,categoryCode="PVE"){
      const response=await fetch(progressApi,{method:"POST",headers:{
        "Content-Type":"application/json",Cookie:cookie},
        body:JSON.stringify({categoryCode,level:15,seasonPoints:12345})});
      return {status:response.status,json:await response.json()};
    }
    assert.equal((await postProgress(cookieFor({canEdit:false}))).status,403,
      "membro regular nao altera Guild Might");
    assert.equal((await postProgress(cookieFor({canEdit:false,canViewContributors:true}))).status,403,
      "oficial com acesso de leitura nao edita Guild Might");
    const manual=await postProgress(policeCookie);
    assert.equal(manual.status,200,"Police salva Guild Might categoria PVE");
    assert.equal(manual.json.level,15);
    const levelRead=await fetch(progressApi,{headers:{Cookie:policeCookie}}).then(r=>r.json());
    assert(levelRead.rows.some(x=>x.categoryCode==="PVE"&&x.level===15&&x.updatedBy==="member-test"),
      "Guild Might registra autor da edicao do Police");
    const names = (key) => good.json.groups[key].map((x) => x.name);
    assert.deepEqual(names("pronto"), ["Alfa"]);
    assert.deepEqual(names("naCallSemPing"), ["Bravo"]);
    assert.deepEqual(names("pingouOffline"), ["Charlie"]);
    assert.deepEqual(names("contribuinte"), ["Delta", "Golf", "Hotel"]);
    assert.deepEqual(names("equipando"), ["Echo"]);
    assert.deepEqual(names("pingouForaDaCall"), ["Foxtrot"]);
    assert.equal(good.json.groups.pronto[0].weapon, "JURADOR");
    assert.equal(good.json.totals.roster, 8);
    assert.equal(good.json.totals.online, 7);
    assert.equal(good.json.totals.pinged, 3);
    assert.equal(good.json.totals.inCall, 2);

    ok("rota: membro=403, vazio=400, CTA ausente=404 e staff=200 com grupos corretos");
    // Integração do Contribuinte 4 (sem alterar os asserts dos tres cargos anteriores).
    const fourText=roster+'\n"NovoQuatro"\t"Online"\t"CONTRIBUINTE 4"';
    const fourPreview=await requestImport("preview",adminCookie,{text:fourText});
    assert.equal(fourPreview.status,200);
    assert.deepEqual(fourPreview.json.groups["4"],["NovoQuatro"]);
    const added=await requestImport("confirm",adminCookie,{
      text:fourText,checksum:fourPreview.json.checksum,
      expectedImportedAt:fourPreview.json.expectedImportedAt,previewedAt:fourPreview.json.previewedAt,
      previewToken:fourPreview.json.previewToken});
    assert.equal(added.status,200);
    assert.equal(added.json.saved.contributors,4);
    const afterFourth=await contributorRead(cookieFor({canEdit:false,canViewContributors:true}));
    assert.equal(afterFourth.status,200);
    const fourth=afterFourth.json.rows.find(x=>x.player==="NovoQuatro");
    assert(fourth&&fourth.level==="4");
    assert.equal(fourth.obligations.paymentRequired,10000000);
    assert.equal(fourth.obligations.ctaRequired,0);
    assert.equal(fourth.assignmentSource,"observed");
    // Apenas a administracao pode confirmar data anterior e importar extrato.
    const assignmentUrl=base+"/api/contributors/assignment";
    const assignmentBody={player:"NovoQuatro",assignedAt:new Date(Date.now()-2*86400000).toISOString()};
    const confirm=(cookie)=>fetch(assignmentUrl,{method:"POST",headers:{
      "Content-Type":"application/json",Cookie:cookie},body:JSON.stringify(assignmentBody)});
    assert.equal((await confirm(cookieFor({canEdit:false,canViewContributors:true}))).status,403);
    assert.equal((await confirm(policeCookie)).status,200,"Police pode definir data do contribuinte");
    assert.equal((await confirm(cookieFor({canEdit:true,isSiteAdmin:true}))).status,200);
    const bankAt=new Date().toISOString().slice(0,19).replace("T"," ");
    const bankTsv="Date\tPlayer\tReason\tAmount\n"+bankAt+"\tNovoQuatro\tDeposit\t10000000\n";
    const bankUrl=base+"/api/contributors/bank-import";
    const submitBank=(cookie)=>fetch(bankUrl,{method:"POST",headers:{
      "Content-Type":"application/json",Cookie:cookie},body:JSON.stringify({text:bankTsv})});
    assert.equal((await submitBank(cookieFor({canEdit:false,canViewContributors:true}))).status,403);
    const firstBank=await submitBank(policeCookie);
    assert.equal(firstBank.status,200,"Police pode importar extrato do banco");
    assert.equal((await firstBank.json()).inserted,1);
    const repeat=await submitBank(cookieFor({canEdit:true,isSiteAdmin:true}));
    assert.equal((await repeat.json()).duplicates,1);
    const afterBank=await contributorRead(cookieFor({canEdit:true,isSiteAdmin:true}));
    assert.equal(afterBank.status,200);
    const updatedTierFour=afterBank.json.rows.find(x=>x.player==="NovoQuatro");
    assert.equal(updatedTierFour.assignmentSource,"confirmed");
    assert.equal(updatedTierFour.payment.creditedCandidate,10000000);
    assert.equal(updatedTierFour.payment.verification,"PENDENTE DE CONFERÊNCIA");
    // O G incompleto nao deve excluir a guilda: transacao e contagem conservadora.
    const dbRoster=await contributorWeekly.rosterLatest(db.pool);
    assert.equal(dbRoster.member_count,9);
    ok("Contribuinte 4: vigencia, autenticação admin, banco deduplicado e relatorio");
 
    // Regressao: staff move a jogadora da vaga Nature para um slot Support
    // e precisa trocar POSTULENTO por PÚTRIDO sem perder a vaga nem receber falso sucesso.
    await db.upsertSignup({
      eventId: ev.id, userId: "camile-test", username: "[IM] CAMILEVEGANA",
      weapon: "POSTULENTO", presence: "online",
      partyIndex: 0, slotIndex: 7, manual: true,
    });
    async function changeWeapon(cookie, userId, weapon) {
      const response = await fetch(base + "/api/setweapon", {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ event: ev.id, userId, weapon }),
      });
      return { status: response.status, json: await response.json() };
    }
    const noPermission = await changeWeapon(cookieFor({ canEdit: false }), "camile-test", "PÚTRIDO");
    assert.equal(noPermission.status, 403, "somente a staff pode editar armas");
    const invalid = await changeWeapon(cookieFor({ canEdit: true }), "camile-test", "ARMA INVENTADA");
    assert.equal(invalid.status, 400, "arma inexistente nao deve ser aceita");
    const missingPlayer = await changeWeapon(cookieFor({ canEdit: true }), "inexistente", "PÚTRIDO");
    assert.equal(missingPlayer.status, 404, "nao deve responder sucesso se o UPDATE afetar zero linhas");
    const updated = await changeWeapon(cookieFor({ canEdit: true }), "camile-test", "PÚTRIDO");
    assert.equal(updated.status, 200);
    assert.equal(updated.json.ok, true);
    assert.equal(updated.json.weapon, "PÚTRIDO");
    const stored = (await db.getSignups(ev.id)).find((x) => x.user_id === "camile-test");
    assert.equal(stored.weapon, "PÚTRIDO", "escolha da staff precisa estar persistida");
    assert.equal(stored.manual, true, "vaga manual deve permanecer travada");
    assert.equal(stored.party_index, 0);
    assert.equal(stored.slot_index, 7);
    const rosterResponse = await fetch(base + "/api/roster?event=" + ev.id, {
      headers: { Cookie: cookieFor({ canEdit: true }) },
    });
    assert.equal(rosterResponse.status, 200);
    const rosterData = await rosterResponse.json();
    assert.equal(rosterData.parties[0].slots[7].weapon, "PÚTRIDO");
    ok("troca POSTULENTO -> PÚTRIDO: verifica permissao, valida, persiste e devolve roster atualizado");

    // Um contribuinte ambiguo nao deve bloquear a importacao de toda a lista.
    const ambiguousRoster=fourText+
      '\n"BadTier"\t"Online"\t"CONTRIBUINTE 1;CONTRIBUINTE 2"'+
      '\n"Repeated"\t"Online"\t"CONTRIBUINTE 3"'+
      '\n"[IM] repeated"\t"Online"\t"CONTRIBUINTE 3"';
    const ambiguousPreview=await requestImport("preview",adminCookie,{text:ambiguousRoster});
    assert.equal(ambiguousPreview.status,200);
    const ignoredPreview=new Map(ambiguousPreview.json.ignoredMembers.map(x=>[x.player,x.reason]));
    assert.match(ignoredPreview.get("BadTier"),/conflitantes/);
    assert.match(ignoredPreview.get("Repeated"),/duplicado/);
    const ambiguousSave=await requestImport("confirm",adminCookie,{
      text:ambiguousRoster,checksum:ambiguousPreview.json.checksum,
      expectedImportedAt:ambiguousPreview.json.expectedImportedAt,previewedAt:ambiguousPreview.json.previewedAt,
      previewToken:ambiguousPreview.json.previewToken});
    assert.equal(ambiguousSave.status,200,"G com conflitos deve ser salvo sem HTTP 500");
    const ambiguousJson=ambiguousSave.json;
    const ignored=new Map(ambiguousJson.saved.ignoredMembers.map(x=>[x.player,x.reason]));
    assert.match(ignored.get("BadTier"),/conflitantes/);
    assert.match(ignored.get("Repeated"),/duplicado/);
    const conflictReport=await contributorRead(cookieFor({canEdit:false,canViewContributors:true}));
    assert.equal(conflictReport.status,200);
    assert.equal(conflictReport.json.rows.some(x=>x.player==="BadTier"),false);
    assert.equal(conflictReport.json.rows.some(x=>x.player==="Repeated"),false);
    assert(conflictReport.json.warnings.some(x=>x.includes("BadTier")));
    assert(conflictReport.json.warnings.some(x=>x.includes("Repeated")));
    ok("Conflitos e nomes duplicados sao ignorados individualmente e avisados");
    const previewOne=await requestImport("preview",adminCookie,{text:ambiguousRoster});
    const previewTwo=await requestImport("preview",adminCookie,{text:ambiguousRoster});
    assert.equal(previewOne.status,200);
    assert.equal(previewTwo.status,200);
    const sameAgain=await requestImport("confirm",adminCookie,{
      text:ambiguousRoster,checksum:previewOne.json.checksum,
      expectedImportedAt:previewOne.json.expectedImportedAt,previewedAt:previewOne.json.previewedAt,
      previewToken:previewOne.json.previewToken});
    assert.equal(sameAgain.status,200);
    const stalePreview=await requestImport("confirm",adminCookie,{
      text:ambiguousRoster,checksum:previewTwo.json.checksum,
      expectedImportedAt:previewTwo.json.expectedImportedAt,previewedAt:previewTwo.json.previewedAt,
      previewToken:previewTwo.json.previewToken});
    assert.equal(stalePreview.status,409,"previa anterior nao pode sobrepor importacao mais recente");
    assert.equal(stalePreview.json.error,"roster_changed");

    // O bootstrap deve suportar um roster previamente salvo que contem cargos conflitantes.
    await db.pool.query("DELETE FROM contributor_active_assignments");
    await assert.doesNotReject(()=>contributorWeekly.init(db.pool));
    const afterBootstrap=await contributorCycle.assignments(db.pool);
    assert(afterBootstrap.some(x=>x.player_name==="NovoQuatro"));
    assert(!afterBootstrap.some(x=>x.player_name==="BadTier"||x.player_name==="Repeated"));
    // Mesmo com uma falha inesperada no bootstrap, o servico nao deve cair.
    const originalBootstrap=contributorCycle.bootstrap, originalConsoleError=console.error;
    const bootstrapErrors=[];
    contributorCycle.bootstrap=async()=>{throw Error("bootstrap simulated failure");};
    console.error=(...args)=>bootstrapErrors.push(args.map(String).join(" "));
    try{await assert.doesNotReject(()=>contributorWeekly.init(db.pool));}
    finally{contributorCycle.bootstrap=originalBootstrap;console.error=originalConsoleError;}
    assert(bootstrapErrors.some(x=>x.includes("bootstrap simulated failure")));
    ok("Bootstrap tolera roster conflitante e registra falha inesperada sem interromper inicializacao");

    // Uma fonte auxiliar com erro nao pode transformar /api/contributors/weekly em HTTP 500.
    const healthyReport=await contributorRead(cookieFor({canEdit:false,canViewContributors:true}));
    assert.equal(healthyReport.status,200);
    for(const [source,warning] of [
      ["attendanceByPlayer","Attendance indisponível nesta consulta"],
      ["assignments","Vínculos de contribuintes indisponíveis nesta consulta"],
      ["deposits","Depósitos indisponíveis nesta consulta"]
    ]){
      const original=contributorCycle[source];
      contributorCycle[source]=async()=>{throw Error("test: "+source+" unavailable");};
      try{
        const response=await contributorRead(cookieFor({canEdit:false,canViewContributors:true}));
        assert.equal(response.status,200,source+" nao deve causar erro HTTP");
        assert(response.json.warnings.includes(warning),source+" deve sinalizar indisponibilidade");
        assert.deepEqual(response.json.rows.map(x=>[x.player,x.level,x.status,x.pveMight,x.gatheringMight]),
          healthyReport.json.rows.map(x=>[x.player,x.level,x.status,x.pveMight,x.gatheringMight]),
          "Classificacao Might permanece intacta sem "+source);
      }finally{contributorCycle[source]=original;}
    }
    ok("Attendance, assignments e deposits com falha: GET permanece HTTP 200 e preserva Might");


  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

async function main() {
  if (!process.env.DATABASE_URL || !/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL)) {
    throw new Error("TESTE RECUSADO: DATABASE_URL precisa apontar para PostgreSQL local temporário.");
  }

  await db.init();
  await telemetry.initSchema(db.pool);
  await contributorWeekly.init(db.pool);
  testBrowserScriptSyntax();
  testMobileAndMuralShell();
  await testRouteAccessAndResponses();
  console.log("\n✅ Guild roster route suite: TODOS OS TESTES PASSARAM");
}

main()
  .then(async () => { await db.pool.end(); })
  .catch(async (err) => {
    console.error("\n❌ Guild roster route suite falhou:", err);
    try { await db.pool.end(); } catch (_) {}
    process.exitCode = 1;
  });

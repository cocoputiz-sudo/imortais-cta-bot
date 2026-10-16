const fs=require('node:fs');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
function render(){
  const module={exports:{}};
  const context={module,exports:module.exports,require:id=>['crypto','path'].includes(id)?require(id):{},
    process:{env:{MACKNA_PREVIEW:'1',SESSION_SECRET:'visual-fixtures-only'}},Buffer,console,
    setInterval:()=>({unref(){}}),__dirname:path.join(root,'src')};
  vm.runInNewContext(fs.readFileSync(path.join(root,'src/web.js'),'utf8'),context);
  return module.exports.renderWarRoomPage();
}
const now='2026-10-16T12:00:00Z';
const week={start:'2026-10-12T00:00:00Z',end:'2026-10-19T00:00:00Z'};
const board={event:{id:89001,time:'17:20',status:'open'},parties:[{display:1,rawParty:0,name:'Party 1',filled:2,total:4,
  slots:[{n:1,filled:true,role:'tank',locked:true,weapon:'MARTELO DE BATALHA',username:'QA_Caller',userId:'qa1',presence:'online'},
  {n:2,filled:true,role:'support',locked:false,weapon:'MONARCA',username:'QA_Alpha',userId:'qa2',presence:'online',options:['MONARCA','JURADOR']},
  {n:3,filled:false,role:'heal',locked:false,options:['ÁRVORE']},{n:4,filled:false,role:'dps',locked:false,options:['URSINAS']}]}],reserves:[]};
const personas={anonymous:{logged:false},member:{logged:true,member:true,name:'QA_Member'},
  outsider:{logged:true,member:false,name:'QA_Outsider'},
  admin:{logged:true,member:true,name:'QA_Admin',canEdit:true,isSiteAdmin:true,canViewContributors:true,
    canEditContributors:true,canEditGuildMight:true,canManageDevices:true}};
function fixtures(auth){return {
 '/auth/me':auth,'/api/health':{ok:true,database:true,discord:false,mode:'preview',discordRequired:false},
 '/api/events':[{id:89001,time:'17:20'}],'/api/roster':board,
 '/api/news':[{author:'QA_Staff',time:now,html:'<h2>CTA DE HOMOLOGAÇÃO</h2><p>Somente dados fictícios.</p>'}],
 '/api/caller':{active:false},'/api/me/stats':{season:34,found:false},
 '/api/telemetry/guild-might':{meta:{categoryCount:0,mappedCategoryCount:0,playerCount:2,storedSnapshots:0},categories:[],
  ranking:[{player:'QA_Alpha',might:12000,categories:1},{player:'QA_Beta',might:6000,categories:1}]},
 '/api/telemetry/guild-progress':{rows:[]},'/api/telemetry/guild-might-ingest-status':{devices:[],totalEvents:0},
 '/api/contributors/weekly':{paymentWeek:week,paymentSummary:{receivedSilver:4000000,payingContributors:1,paid:1,pending:1,unlinked:0},
  counts:{},categories:{},rows:[{player:'QA_Alpha',level:'1',cycle:week,payment:{status:'PAGO',amount:4000000,due:4000000,found:1,paidAt:now},
    obligations:{ctaRequired:10,paymentRequired:4000000},attendance:{count:0},cycleMight:{}}],unlinkedDeposits:[],warnings:[]},
 '/api/contributors/settings':{minima:{},reminderEnabled:false},
 '/api/contributors/billing':{week,settings:{enabled:false},rows:[{player:'QA_Alpha',level:'1',week:week.start,due:4000000,paid:0,
   currentRemaining:4000000,currentWeekKey:'2026-10-12',totalOtherDebt:0,overdue:[],link:{status:'pending',discord_user_id:'100000000000000001'}}]},
 '/api/telemetry/guild-presence':{members:[],online:0,total:0},'/api/telemetry/agents':[],
 '/api/scout':{season:null,rows:[]},'/api/scout/me':{found:false},
 '/api/navigation/state':{queue:[],objectives:[],position:null,graph:{zones:0}},
 '/api/telemetry/confirm':{players:[],parties:[],summary:{}},
 '/api/telemetry/loot-ctas':[], '/api/telemetry/combat-ctas':[]
};}
(async()=>{
 const html=render(),browser=await chromium.launch({headless:true,...(process.env.QA_CHROMIUM_PATH?{executablePath:process.env.QA_CHROMIUM_PATH}:{}),
   args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 const report={source:'PR89 src/web.js exact renderer with synthetic browser API responses',browser:await browser.version(),sourceCommit:process.env.QA_SOURCE_COMMIT||null,cases:[]};
 try { for(const viewport of [{width:1440,height:1000},{width:390,height:844},{width:320,height:740}]){
  for(const persona of ['anonymous','outsider','member','admin']){
   const context=await browser.newContext({viewport}),page=await context.newPage();
   const errors=[],unknown=[],writes=[],data=fixtures(personas[persona]);
   page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(board=>{window.EventSource=class{constructor(url){this.url=url;if(url.startsWith('/api/stream'))setTimeout(()=>this.onmessage?.({data:JSON.stringify(board)}),10);}close(){}};},board);
   await page.route('**/*',async route=>{
     const url=new URL(route.request().url());
     if(route.request().method()==='POST'){
       writes.push({path:url.pathname,body:route.request().postDataJSON()});
       const response=url.pathname==='/api/telemetry/pairing/create'?{code:'QA89TEST'}:{ok:true};
       await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(response)});return;
     }
     if(url.origin!=='http://qa.imortais.test'){await route.fulfill({status:204,body:''});return;}
     if(url.pathname==='/'){await route.fulfill({status:200,contentType:'text/html',body:html});return;}
     if(url.pathname.startsWith('/assets/')){const asset=path.join(root,url.pathname);await route.fulfill({status:200,contentType:'image/png',body:fs.readFileSync(asset)});return;}
     if(data[url.pathname]!==undefined){await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data[url.pathname])});return;}
     unknown.push(url.pathname);await route.fulfill({status:404,contentType:'application/json',body:'{"error":"fixture not defined"}'});
   });
   await page.goto('http://qa.imortais.test/');await page.waitForTimeout(200);
   const prefix=persona+'-'+viewport.width;
   const member=!!personas[persona].member;
   assert.equal(await page.locator('#mobile-nav').isVisible(),member&&viewport.width<900,'mobile menu respects membership');
   if(persona!=='admin')assert.equal(await page.locator('.nav[data-view="devices"]:visible').count(),0,'all device menu copies must be hidden');
   if(!member)assert((await page.locator('#gate').innerText()).length>0,'authentication gate required');
   const results=[];
   const views=persona==='admin'?['board','mural','might','contributors','devices','guild','scout','navigation','confirm','loot','combat']:['board'];
   for(const view of views){
    if(view!=='board'){await page.locator('.nav[data-view="'+view+'"]:visible').first().click();await page.waitForTimeout(120);}
    const state=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,navVisible:!!document.querySelector('#mobile-nav')?.getBoundingClientRect().height,
      gate:document.querySelector('#gate').innerText,text:document.querySelector('#main').innerText.slice(0,200),
      devicesNav:[...document.querySelectorAll('.nav[data-view="devices"]')].map(e=>getComputedStyle(e).display)}));
    const file=prefix+'-'+view+'.png';await page.screenshot({path:path.join(root,'artifacts',file),fullPage:true});
    assert(state.scroll<=state.width+1,'no page-wide horizontal overflow: '+prefix+' '+view);
    if(view==='might'){
      await page.locator('#gm-player-search').fill('QA_Beta');
      assert.equal(await page.locator('[data-gm-player="QA_Alpha"]:visible').count(),0);
      assert.equal(await page.locator('[data-gm-player="QA_Beta"]:visible').count(),1);
    }
    if(view==='devices'){
      if(viewport.width<=600)assert(await page.locator('#pair-label').evaluate(e=>e.getBoundingClientRect().width)>200,'mobile pairing fields need usable width');
      await page.locator('#pair-label').fill('QA_Device');await page.locator('#pair-player').fill('QA_Alpha');
      await page.locator('#pair-generate').click();await page.waitForTimeout(80);
      assert.match(await page.locator('#pair-result').innerText(),/QA89TEST/);
      assert(writes.some(x=>x.path==='/api/telemetry/pairing/create'&&x.body.label==='QA_Device'&&x.body.playerName==='QA_Alpha'));
    }
    results.push({view,...state,screenshot:file});
   }
   if(persona==='admin'&&viewport.width===1440){
     data['/api/health']={ok:false,database:false,discord:false,mode:'preview'};
     await page.evaluate(()=>checkConnection());await page.waitForTimeout(100);
     assert.match(await page.locator('#live').innerText(),/banco indisponível/,'database outage must show the actual cause');
   }
   assert.deepEqual(errors,[],'browser must not throw');assert.deepEqual(unknown,[],'every API must have an explicit fixture');
   report.cases.push({persona,viewport,results,errors,unknown:[...new Set(unknown)],writes});
   await context.close();
  }
 }
 } finally { await browser.close(); }
 fs.writeFileSync(path.join(root,'artifacts/probe-report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exitCode=1;});

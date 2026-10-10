"use strict";
const VALID=new Set(["CASTLE","CORRUPTED","DRAGON_AREA","DRAGON_HUNT","ENERGYCRYSTAL","GATHERING",
 "GVGSEASON","HELLDUNGEON","HELLGATE","POWERCORE","PVE","SMUGGLERS","SPIDERS","TREASURES",
 "GUILD_CHALLENGE"]);
async function init(pool){
 await pool.query(`CREATE TABLE IF NOT EXISTS guild_manual_progress (
  category_code TEXT PRIMARY KEY, level INTEGER, season_points BIGINT,
  updated_by TEXT NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT progress_level_range CHECK (level IS NULL OR (level BETWEEN 0 AND 10000)),
  CONSTRAINT progress_points_range CHECK (season_points IS NULL OR season_points>=0)
 )`);
}
async function all(pool){const {rows}=await pool.query("SELECT category_code,level,season_points,updated_by,updated_at FROM guild_manual_progress ORDER BY category_code");return rows.map(r=>({categoryCode:r.category_code,level:r.level,seasonPoints:r.season_points===null?null:Number(r.season_points),source:"admin_manual",updatedBy:r.updated_by,updatedAt:r.updated_at}));}
async function save(pool,body,user){
 const code=String(body?.categoryCode||"").trim().toUpperCase();
 if(!VALID.has(code))throw Error("invalid_category");
 const parse=(v,max)=>{if(v==null||v==="")return null;const n=Number(v);if(!Number.isSafeInteger(n)||n<0||n>max)throw Error("invalid_number");return n};
 const level=parse(body.level,10000),seasonPoints=parse(body.seasonPoints,1000000000000);
 const by=String(user||"admin").slice(0,120);
 await pool.query(`INSERT INTO guild_manual_progress(category_code,level,season_points,updated_by,updated_at)
 VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(category_code) DO UPDATE
 SET level=EXCLUDED.level,season_points=EXCLUDED.season_points,
 updated_by=EXCLUDED.updated_by,updated_at=NOW()`,[code,level,seasonPoints,by]);
 return {categoryCode:code,level,seasonPoints,source:"admin_manual"};
}
module.exports={init,all,save,VALID};

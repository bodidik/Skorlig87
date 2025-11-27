const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

async function mkdirp(p){ await fsp.mkdir(p, { recursive: true }); }

async function readJson(file, fallback=null){
  try{
    const txt = await fsp.readFile(file, "utf8");
    return JSON.parse(txt);
  }catch(e){ return fallback; }
}

async function writeJson(file, data){
  const dir = path.dirname(file);
  await mkdirp(dir);
  const tmp = file + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, file);
  return true;
}

module.exports = { mkdirp, readJson, writeJson };

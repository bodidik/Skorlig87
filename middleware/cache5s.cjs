/**
 * middleware/cache5s.cjs
 * Aynı route çıktısını 5 saniye cache'ler
 */
const store = new Map();
function cache5s(req,res,next){
  const key = req.originalUrl;
  const now = Date.now();
  const entry = store.get(key);
  if(entry && (now - entry.time < 5000)){
    res.set("X-Cache","HIT");
    return res.json(entry.data);
  }
  const orig = res.json.bind(res);
  res.json = (body)=>{
    store.set(key,{time:Date.now(),data:body});
    res.set("X-Cache","MISS");
    return orig(body);
  };
  next();
}
module.exports = cache5s;

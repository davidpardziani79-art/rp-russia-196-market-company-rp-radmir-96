const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=process.env.PORT||3000,DATA=process.env.DATA_DIR||path.join(__dirname,'data'),FILE=path.join(DATA,'db.json');
fs.mkdirSync(DATA,{recursive:true});let db={users:[],sessions:{},topics:[],apps:[]};
if(fs.existsSync(FILE)){try{db=JSON.parse(fs.readFileSync(FILE,'utf8'));}catch(e){console.error('Failed to read DB',e)}}
db.apps=db.apps||[];db.users=db.users||[];db.sessions=db.sessions||{};db.topics=db.topics||[];
db.topics=(db.topics||[]).filter(t=>!(t.author==='Система'&&['welcome','chat'].includes(t.id)));
function persist(){let tmp=FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(db));fs.renameSync(tmp,FILE)}
const id=()=>crypto.randomBytes(18).toString('hex'),hash=(p,s)=>crypto.scryptSync(p,s,64).toString('hex');
function reply(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj))}
function err(res,status,msg){reply(res,status,{error:msg})}
const MAX_BODY=240000;function body(req){return new Promise((resolve,reject)=>{let s='',n=0;req.on('data',c=>{n+=c.length;if(n>MAX_BODY){reject(Error('Слишком большой запрос'));req.destroy();return}s+=c});req.on('end',()=>{try{resolve(JSON.parse(s||'{}'))}catch{reject(Error('Неверный JSON'))}});req.on('error',reject)})}
function current(req){let t=(req.headers.authorization||'').match(/^Bearer ([a-f0-9]{64})$/)?.[1];let session=t&&db.sessions[t];if(!session||session.expires<Date.now())return null;let user=db.users.find(u=>u.id===session.uid);return user&&!user.banned?{user,token:t,session}:null}
const publicUser=u=>({id:u.id,nick:u.nick,joined:u.joined,bio:u.bio||'',avatar:u.avatar||'',role:u.role==='admin'?'admin':'player',banned:!!u.banned,online:!u.banned&&!!u.lastSeen&&Date.now()-u.lastSeen<45000});
const isAdmin=a=>a?.user?.role==='admin'&&!a.user.banned;
const adminGrants=new Map();
function grantValid(req,a){const key=req.headers['x-admin-access'];const g=key&&adminGrants.get(key);return !!(g&&g.session===a.token&&g.expires>Date.now())}
function adminOnly(req,res){let a=auth(req,res);if(!a)return null;if(!isAdmin(a)||!grantValid(req,a)){err(res,403,'Введите код администратора в этом посещении');return null}return a}
function findUser(uid){return db.users.find(u=>u.id===uid)}

function auth(req,res){let a=current(req);if(!a){err(res,401,'Сначала войди в аккаунт');return null}return a}
const sections=['Новости проекта','Общение','Государственные организации','Автомобили и транспорт','Жалобы и предложения'];
const hits=new Map();function rate(req,res){const ip=req.socket.remoteAddress||'unknown',now=Date.now(),x=hits.get(ip)||[];let recent=x.filter(t=>now-t<60000);recent.push(now);hits.set(ip,recent);if(recent.length>100){err(res,429,'Слишком много запросов');return false}return true}
const server=http.createServer(async(req,res)=>{let url;try{url=new URL(req.url,'http://localhost')}catch{return err(res,400,'Неверный адрес')}
res.setHeader('X-Content-Type-Options','nosniff');if(url.pathname==='/health')return reply(res,200,{ok:true});
if(!url.pathname.startsWith('/api/')){if(req.method!=='GET'||(url.pathname!=='/'&&url.pathname!=='/index.html'))return err(res,404,'Не найдено');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});return fs.createReadStream(path.join(__dirname,'index.html')).pipe(res)}
if(!rate(req,res))return;
try{let p=url.pathname.slice(5),d=req.method==='POST'?await body(req):{};
if(p==='state'&&req.method==='GET'){let a=current(req);if(a){a.user.lastSeen=Date.now();a.session.expires=Date.now()+30*86400000;persist()}return reply(res,200,{users:db.users.map(publicUser),topics:db.topics,apps:db.apps.map(x=>({id:x.id,user:x.user,author:x.author||db.users.find(u=>u.id===x.user)?.nick||'Игрок',type:x.type,title:x.title,body:x.body,status:x.status,time:x.time,adminReply:x.adminReply||'',answeredBy:x.answeredBy||'',answeredAt:x.answeredAt||null})),me:a?publicUser(a.user):null,online:db.users.filter(u=>publicUser(u).online).length})}
if(p==='admin/unlock'&&req.method==='POST'){
 let a=auth(req,res);if(!a)return;
 const nick='David_Kuertov';
 const given=String(d.key||'');
 const expected=Buffer.from('638bca7796796aa0cc01ee39bbac0240532c49a4ef9572a3810e78bfca408827','hex');
 const actual=crypto.scryptSync(given,'rp196-admin-v4-2026',32);
 if(a.user.nick.toLowerCase()!==nick.toLowerCase()||!crypto.timingSafeEqual(actual,expected))return err(res,403,'Неверный код или недостаточно прав');
 if(a.user.role!=='admin'){
   if(db.users.some(u=>u.role==='admin'&&u.id!==a.user.id))return err(res,403,'Главный администратор уже назначен');
   a.user.role='admin';persist();
 }
 const grant=crypto.randomBytes(32).toString('hex');adminGrants.set(grant,{session:a.token,expires:Date.now()+8*3600000});
 return reply(res,200,{ok:true,grant,nick:a.user.nick});
}
if(p==='admin/action'&&req.method==='POST'){
 let a=adminOnly(req,res);if(!a)return;
 let action=String(d.action||''),target=findUser(String(d.userId||''));
 if(['ban','unban','role','kick'].includes(action)){
  if(!target)return err(res,404,'Игрок не найден');
  if(target.id===a.user.id)return err(res,400,'Нельзя изменять свой аккаунт');
  if(target.role==='admin'&&['ban','kick'].includes(action))return err(res,403,'Нельзя забанить другого администратора');
  if(action==='ban'){target.banned=true;target.lastSeen=0;for(const [t,session] of Object.entries(db.sessions))if(session.uid===target.id)delete db.sessions[t]}
  if(action==='kick'){target.lastSeen=0;for(const [t,session] of Object.entries(db.sessions))if(session.uid===target.id)delete db.sessions[t]}
  if(action==='unban')target.banned=false;
  if(action==='role'){if(target.nick.toLowerCase()==='David_Kuertov'.toLowerCase())return err(res,403,'Нельзя снять роль главного администратора');if(!['player','admin'].includes(d.role))return err(res,400,'Неизвестная роль');target.role=d.role}
 }else if(action==='deleteTopic'){
  const index=db.topics.findIndex(t=>t.id===d.topicId);if(index<0)return err(res,404,'Тема не найдена');db.topics.splice(index,1);
 }else if(action==='deleteReply'){
  const topic=db.topics.find(t=>t.id===d.topicId);if(!topic||!Number.isInteger(d.index)||d.index<0||d.index>=topic.replies.length)return err(res,404,'Ответ не найден');topic.replies.splice(d.index,1);
 }else if(action==='application'){
  const app=db.apps.find(x=>x.id===d.appId);if(!app)return err(res,404,'Заявка не найдена');if(!['На рассмотрении','Одобрено','Отклонено'].includes(d.status))return err(res,400,'Неизвестный статус');app.status=d.status;
 }else if(action==='replyApplication'){
  const app=db.apps.find(x=>x.id===d.appId);if(!app)return err(res,404,'Заявка не найдена');const msg=String(d.message||'').trim();if(msg.length<2||msg.length>3000)return err(res,400,'Ответ от 2 до 3000 символов');app.adminReply=msg;app.answeredBy=a.user.nick;app.answeredAt=Date.now();
 }else return err(res,400,'Неизвестное действие');
 persist();return reply(res,200,{ok:true});
}

if((p==='register'||p==='login')&&req.method==='POST'){let nick=String(d.nick||'').trim(),pass=String(d.pass||'');if(!/^[A-Za-zА-Яа-яЁё0-9_]{3,24}$/.test(nick)||pass.length<5||pass.length>128)return err(res,400,'Ник от 3 до 24 символов, пароль от 5 до 128');let u=db.users.find(x=>x.nick.toLowerCase()===nick.toLowerCase());if(p==='register'){if(u)return err(res,409,'Этот ник уже занят');let salt=id();u={id:id(),nick,salt,hash:hash(pass,salt),joined:Date.now(),bio:'',lastSeen:Date.now()};db.users.push(u)}else{if(!u)return err(res,401,'Неверный ник или пароль');if(u.banned)return err(res,403,'Аккаунт заблокирован');let expected=Buffer.from(u.hash,'hex'),actual=Buffer.from(hash(pass,u.salt),'hex');if(expected.length!==actual.length||!crypto.timingSafeEqual(expected,actual))return err(res,401,'Неверный ник или пароль')}
let token=crypto.randomBytes(32).toString('hex');db.sessions[token]={uid:u.id,expires:Date.now()+30*86400000};u.lastSeen=Date.now();persist();return reply(res,200,{token,user:publicUser(u)})}
if(p==='logout'&&req.method==='POST'){let a=current(req);if(a){for(const [k,g] of adminGrants)if(g.session===a.token)adminGrants.delete(k);delete db.sessions[a.token];a.user.lastSeen=0;persist()}return reply(res,200,{ok:true})}
if(p==='leave'&&req.method==='POST'){let a=current(req);if(a){a.user.lastSeen=0;persist()}return reply(res,200,{ok:true})}
if(p==='heartbeat'&&req.method==='POST'){let a=auth(req,res);if(!a)return;a.user.lastSeen=Date.now();a.session.expires=Date.now()+30*86400000;persist();return reply(res,200,{ok:true})}
if(p==='avatar'&&req.method==='POST'){let a=auth(req,res);if(!a)return;let avatar=String(d.avatar||'');if(avatar&&!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar))return err(res,400,'Поддерживаются только JPG, PNG и WebP');if(avatar&&Buffer.byteLength(avatar,'utf8')>210000)return err(res,413,'Аватар слишком большой');a.user.avatar=avatar;persist();return reply(res,200,{ok:true,user:publicUser(a.user)})}
if(p==='profile'&&req.method==='POST'){let a=auth(req,res);if(!a)return;a.user.bio=String(d.bio||'').trim().slice(0,300);persist();return reply(res,200,{ok:true})}
if(p==='topics'&&req.method==='POST'){let a=auth(req,res);if(!a)return;let title=String(d.title||'').trim(),text=String(d.body||'').trim(),section=String(d.section||'');if(title.length<5||title.length>100||text.length<5||text.length>5000||!sections.includes(section))return err(res,400,'Проверь название, текст и раздел');let t={id:id(),title,body:text,section,author:a.user.nick,time:Date.now(),replies:[]};db.topics.push(t);persist();return reply(res,201,{id:t.id})}
let m=p.match(/^topics\/([a-f0-9]+)\/replies$/);if(m&&req.method==='POST'){let a=auth(req,res);if(!a)return;let t=db.topics.find(x=>x.id===m[1]),text=String(d.body||'').trim();if(!t)return err(res,404,'Тема не найдена');if(text.length<2||text.length>2000)return err(res,400,'Ответ от 2 до 2000 символов');t.replies.push({author:a.user.nick,body:text,time:Date.now()});persist();return reply(res,201,{ok:true})}
if(p==='applications'&&req.method==='POST'){let a=auth(req,res);if(!a)return;let title=String(d.title||'').trim(),text=String(d.body||'').trim(),type=String(d.type||'').slice(0,80);if(title.length<5||title.length>100||text.length<10||text.length>5000)return err(res,400,'Заполни заявку');db.apps.push({id:id(),user:a.user.id,author:a.user.nick,type,title,body:text,status:'На рассмотрении',time:Date.now()});persist();return reply(res,201,{ok:true})}
return err(res,404,'Неизвестный запрос')
}catch(e){console.error(e);return err(res,500,'Ошибка обработки запроса')}});
server.listen(PORT,'0.0.0.0',()=>console.log('RP Russia 196 listening on',PORT));

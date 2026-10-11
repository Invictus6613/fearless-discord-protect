import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import pg from 'pg';
import { Client, GatewayIntentBits, PermissionFlagsBits, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, EmbedBuilder } from 'discord.js';

const required = ['DISCORD_TOKEN','CLIENT_ID','CLIENT_SECRET','GUILD_ID','VERIFIED_ROLE_ID','VERIFY_CHANNEL_ID','PUBLIC_URL'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key} in .env`);
const cfg = process.env;
const base = cfg.PUBLIC_URL.replace(/\/$/,'');
if (!cfg.DATABASE_URL) throw new Error('Missing DATABASE_URL. Configure a persistent PostgreSQL database on Render before starting the bot.');
const pool = new pg.Pool({connectionString:cfg.DATABASE_URL,ssl:cfg.DATABASE_SSL==='true'?{rejectUnauthorized:false}:undefined});
const envBlocked = [...new Set((cfg.BLOCKED_SERVER_IDS||'').split(/[\s,;]+/).filter(x=>/^\d{17,22}$/.test(x)))];
async function initializeStorage(){
  await pool.query('CREATE TABLE IF NOT EXISTS safeguard_blocked_servers (guild_id TEXT PRIMARY KEY, added_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  // Dedicated new-member table: never migrate legacy pending rows into it.
  await pool.query('CREATE TABLE IF NOT EXISTS safeguard_new_members (user_id TEXT PRIMARY KEY, joined_at BIGINT NOT NULL)');
  // Import environment defaults without deleting any servers added through slash commands.
  for(const id of envBlocked) await pool.query('INSERT INTO safeguard_blocked_servers(guild_id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
  console.log(`[Safeguard] PostgreSQL ready; ${await blockedCount()} restricted servers (${envBlocked.length} environment defaults).`);
}
async function blockedCount(){const r=await pool.query('SELECT COUNT(*)::int AS n FROM safeguard_blocked_servers');return r.rows[0].n;}
async function blockedIds(){const r=await pool.query('SELECT guild_id FROM safeguard_blocked_servers ORDER BY guild_id');return r.rows.map(x=>x.guild_id);}
async function recordNewJoin(member) {
  // Only GuildMemberAdd may register a newly joined member. Never scan at startup.
  const joinedAt = member.joinedTimestamp;
  if (!Number.isSafeInteger(joinedAt)) throw new Error('Missing member join timestamp');
  await pool.query('INSERT INTO safeguard_new_members(user_id,joined_at) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET joined_at=EXCLUDED.joined_at',[member.id,joinedAt]);
}
async function clearNewJoin(id) {await pool.query('DELETE FROM safeguard_new_members WHERE user_id=$1',[id]);}
async function isRecordedNewJoin(member) {
  const result=await pool.query('SELECT joined_at FROM safeguard_new_members WHERE user_id=$1',[member.id]);
  return result.rowCount===1 && Number(result.rows[0].joined_at)===member.joinedTimestamp;
}
const bot = new Client({intents:[GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]});
const states = new Map();
// Explicitly disabled until an administrator deliberately opts in.
const kicksEnabled = cfg.KICKS_ENABLED === 'true';
// Rate limit in memory: restart resets it, but defaults remain disabled.
const kickAttempts = [];
let kickCircuitOpen = false;
function allowKickAttempt() {
  if (!kicksEnabled || kickCircuitOpen) return false;
  const now = Date.now();
  while (kickAttempts.length && now - kickAttempts[0] > 60 * 60 * 1000) kickAttempts.shift();
  // At most 3 kick attempts per rolling hour, including failures.
  if (kickAttempts.length >= 3) { kickCircuitOpen = true; console.error('[Safeguard] KICK CIRCUIT BREAKER OPEN: maximum 3 attempts per hour reached. Restart with KICKS_ENABLED=false and investigate.'); return false; }
  kickAttempts.push(now);
  return true;
}

const app = express();
let storageReady = false;
app.disable('x-powered-by');
function button(){ return new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Verify with Discord').setStyle(ButtonStyle.Link).setURL(`${base}/`)); }
async function logEvent({title, color=0x64748b, member, reason, blockedIds=[], outcome, error}) {
  if (!cfg.LOG_CHANNEL_ID) return;
  const ch = await bot.channels.fetch(cfg.LOG_CHANNEL_ID).catch(e => { console.error('Log channel lookup failed:',e.message); return null; });
  if (!ch?.isTextBased()) { console.warn('LOG_CHANNEL_ID does not point to an accessible text channel'); return; }
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setTimestamp()
    .setFooter({text:'Fearless Safeguard • No Swipe RP'});
  if (member) embed.addFields(
    {name:'Member',value:`${member.user.tag}`,inline:true},
    {name:'Discord ID',value:`${member.id}`,inline:true}
  );
  if (reason) embed.addFields({name:'Reason',value:String(reason).slice(0,1024)});
  if (blockedIds.length) embed.addFields({name:'Matched restricted server IDs',value:blockedIds.join(', ').slice(0,1024)});
  if (outcome) embed.addFields({name:'Action',value:outcome.slice(0,1024)});
  if (error) embed.addFields({name:'Error',value:String(error).slice(0,1024)});
  await ch.send({embeds:[embed],allowedMentions:{parse:[]}}).catch(e=>console.error('Failed to send safeguard log:',e.message));
}
async function log(message){ await logEvent({title:'Safeguard Notice',reason:message}); }
async function kick(member, reason, blockedIds=[]) {
  // Defense in depth: this function cannot kick legacy or already-verified members.
  if(reason !== 'Membership in a blocked Discord server' || member.roles.cache.has(cfg.VERIFIED_ROLE_ID) || !(await isRecordedNewJoin(member))) {
    console.warn(`[Safeguard] Refused kick for protected member ${member.id}`);
    return false;
  }
  if (!allowKickAttempt()) {
    console.warn(`[Safeguard] KICK BLOCKED by safety controls for ${member.id}: ${reason}`);
    await logEvent({title:'Removal blocked by safety controls',color:0xf59e0b,member,reason,blockedIds,outcome:'No kick attempted; manual moderator review required'});
    return false;
  }
  if (!member.kickable) {
    await logEvent({title:'Kick Failed',color:0xf59e0b,member,reason,blockedIds,outcome:'Member was not kicked',error:'Missing Kick Members permission or bot role is too low'});
    return false;
  }
  try {
    await member.kick(reason);
    await clearNewJoin(member.id);
    await logEvent({title:'Member Kicked',color:0xef4444,member,reason,blockedIds,outcome:'Successfully kicked'});
    return true;
  } catch(e) {
    await logEvent({title:'Kick Failed',color:0xf59e0b,member,reason,blockedIds,outcome:'Member was not kicked',error:e.message});
    console.error('Safeguard kick failed:',e);
    return false;
  }
}
async function schedule(member){
  if(member.user.bot || member.roles.cache.has(cfg.VERIFIED_ROLE_ID)) return;
  if (!storageReady) {console.warn(`[Safeguard] Join ${member.id} not registered: storage unavailable`); return;}
  await recordNewJoin(member);
  // No per-member verification message or ping. The pinned /verifypanel
  // embed is the only verification entry point.
  console.log(`[Safeguard] Registered new member ${member.id} for silent verification.`);
}
// Timeouts NEVER kick. This intentionally disables historical and new-member
// timeout removals; moderators can review pending members manually.
async function sweep(){ return; }
const commands=[new SlashCommandBuilder().setName('blockserver').setDescription('Manage blocked Discord server IDs').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addSubcommand(s=>s.setName('add').setDescription('Block a server').addStringOption(o=>o.setName('id').setDescription('Discord server ID').setRequired(true))).addSubcommand(s=>s.setName('remove').setDescription('Unblock a server').addStringOption(o=>o.setName('id').setDescription('Discord server ID').setRequired(true))).addSubcommand(s=>s.setName('list').setDescription('List blocked IDs')),new SlashCommandBuilder().setName('verifypanel').setDescription('Post and pin the verification notice').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)];
bot.once(Events.ClientReady,async()=>{
  try {
    await initializeStorage();
    storageReady = true;
    await bot.application.commands.set(commands.map(c=>c.toJSON()),cfg.GUILD_ID);
    console.log(`Logged in as ${bot.user.tag}`);
    const guild=await bot.guilds.fetch(cfg.GUILD_ID);
    // No startup member scan. Legacy safeguard_pending is deliberately ignored.
    console.warn('[Safeguard] Only GuildMemberAdd events register new members; timeout kicks are DISABLED.');
    console.warn(`[Safeguard] Automatic blocked-server kicks: ${kicksEnabled ? 'OPTED IN (max 3 attempts/hour)' : 'DISABLED (default)'}.`);
  } catch(e){console.error('[Safeguard] Startup failed:',e);process.exitCode=1;await bot.destroy();await pool.end();}
});
bot.on(Events.GuildMemberAdd,member=>{if(member.guild.id===cfg.GUILD_ID)schedule(member).catch(console.error)});
bot.on(Events.GuildMemberRemove,member=>{if(member.guild.id===cfg.GUILD_ID)clearNewJoin(member.id).catch(console.error)});
bot.on(Events.InteractionCreate,async i=>{
  if(!i.isChatInputCommand()||i.guildId!==cfg.GUILD_ID)return;
  if(!i.memberPermissions?.has(PermissionFlagsBits.Administrator))return i.reply({content:'Administrator only.',ephemeral:true});
  if(i.commandName==='verifypanel'){
    await i.deferReply({ephemeral:true});
    try {
      const ch=await bot.channels.fetch(cfg.VERIFY_CHANNEL_ID);
      if(!ch?.isTextBased() || !ch.send) return i.editReply('VERIFY_CHANNEL_ID must refer to a text channel where the bot can send messages.');
      const embed=new EmbedBuilder()
        .setColor(0xe53935)
        .setTitle('🛡️ NO SWIPE RP™ | VERIFICATION NOTICE')
        .setDescription('**All new members must complete verification to access No Swipe RP™.**\n\nTo protect our community, membership in certain Discord servers is not permitted during verification.')
        .addFields(
          {name:'🚫 RESTRICTED DISCORD SERVERS',value:'🔴 **Shenanigans**\n🔴 **Fivevault**\n🔴 **Launcher Leaks**'},
          {name:'⚠️ IF YOU BELONG TO ONE OF THESE SERVERS',value:'Your verification will be **DENIED**. New members who complete verification with a confirmed restricted-server match may be **kicked** when automatic enforcement is enabled.'},
          {name:'✅ HOW TO GET VERIFIED',value:'1. Leave **all** restricted Discord servers listed above.\n2. Return to No Swipe RP™.\n3. Click the button below and complete verification.'},
          {name:'🔐 YOUR PRIVACY',value:'Discord authorization checks your account and server memberships. We never ask for your password.'}
        )
        .setFooter({text:'No Swipe RP™ Management • Protected by Fearless Safeguard'});
      const message=await ch.send({embeds:[embed],components:[button()],allowedMentions:{parse:[]}});
      try {
        await message.pin();
        return i.editReply(`Verification notice posted and pinned in <#${ch.id}>.`);
      } catch(pinError) {
        console.error('[Safeguard] Unable to pin verification notice:',pinError);
        return i.editReply(`Verification notice posted in <#${ch.id}>, but could not be pinned. Give the bot Manage Messages permission, then pin the message manually.`);
      }
    }catch(e){console.error('[Safeguard] Verification panel failed:',e);return i.editReply('Could not post the verification notice. Check the bot channel permissions and VERIFY_CHANNEL_ID.');}
  }
  try {
    const action=i.options.getSubcommand();const id=i.options.getString('id');
    if(action==='list'){
      const ids=await blockedIds();
      return i.reply({content:ids.length?ids.join('\n').slice(0,1900):'No blocked servers.',ephemeral:true});
    }
    if(!/^\d{17,22}$/.test(id))return i.reply({content:'Enter a valid numeric Discord server ID.',ephemeral:true});
    if(action==='add')await pool.query('INSERT INTO safeguard_blocked_servers(guild_id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
    else await pool.query('DELETE FROM safeguard_blocked_servers WHERE guild_id=$1',[id]);
    await i.reply({content:`${action==='add'?'Blocked':'Unblocked'} server ${id}. Stored permanently in PostgreSQL.`,ephemeral:true});
  }catch(e){console.error('[Safeguard] Command error:',e);if(!i.replied)await i.reply({content:'Database unavailable. No change was confirmed; please try again.',ephemeral:true}).catch(()=>{});}
});

const htmlEscape = (value) => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const page = (title, content) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(title)} | Fearless Safeguard</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 50% -20%,#641b28 0%,#15151a 45%,#0b0c10 100%);color:#f6f5f7;font-family:Inter,system-ui,-apple-system,Segoe UI,Arial,sans-serif;line-height:1.65}
header{border-bottom:1px solid #ffffff18;background:#08090db8}nav{max-width:960px;margin:auto;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}nav strong{letter-spacing:.09em;font-size:15px}nav a,footer a{color:#cfc9d1;text-decoration:none;margin-left:16px}nav a:hover,footer a:hover{text-decoration:underline}
main{max-width:850px;margin:72px auto 80px;padding:0 24px}.hero{text-align:center;max-width:670px;margin:auto}.eyebrow{color:#f99aa7;font-size:12px;font-weight:800;letter-spacing:.2em;text-transform:uppercase}h1{font-size:clamp(34px,6vw,60px);line-height:1.12;margin:12px 0 20px}h2{margin-top:34px;font-size:22px}p,li{color:#c6c2c9}.lead{font-size:18px}a{color:#ff9aa9}.button{display:inline-block;background:#c72f48;color:white;text-decoration:none;font-weight:750;padding:15px 27px;border-radius:10px;margin-top:20px;box-shadow:0 10px 30px #0005}.button:hover{background:#df3954}.panel{border:1px solid #ffffff21;background:#ffffff09;border-radius:18px;padding:28px;margin-top:32px}.panel h1{font-size:38px}.panel h2{font-size:20px}footer{border-top:1px solid #ffffff18;text-align:center;padding:25px 12px;font-size:13px;color:#a6a0aa}footer a{margin:0 9px}ul{padding-left:23px}strong{color:#fff}@media(max-width:520px){main{margin-top:45px}nav a{margin-left:8px}}
</style></head><body><header><nav><strong>🛡 FEARLESS SAFEGUARD</strong><div><a href="/">Home</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></div></nav></header><main>${content}</main><footer>© ${new Date().getFullYear()} No Swipe RP · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a></footer></body></html>`;
const legalIntro = '<p><strong>Effective date:</strong> October 11, 2026<br><strong>Operator:</strong> No Swipe RP community administration</p>';
app.get('/', (req,res) => res.type('html').send(page('Verify your Discord account', `
<section class="hero"><div class="eyebrow">No Swipe RP · Discord Security</div><h1>Welcome to Fearless Safeguard</h1>
<p class="lead">Verify your Discord account to access the No Swipe RP community. Authorization lets us check your Discord identity and server memberships against our restricted-server list.</p>
<a class="button" href="/authorize">Verify with Discord →</a>
<p style="font-size:13px;margin-top:18px">You will be redirected to Discord to authorize access. We never ask for your password.</p></section>
<section class="panel"><h2>How verification works</h2><p>1. Click <strong>Verify with Discord</strong> and approve Discord's authorization request.</p><p>2. We check your account against the community's verification requirements.</p><p>3. If approved, the bot assigns your Verified role. There are no automatic timeout removals.</p></section>`)));
app.get('/privacy', (req,res) => res.type('html').send(page('Privacy Policy', `
<article class="panel"><div class="eyebrow">Fearless Safeguard</div><h1>Privacy Policy</h1>${legalIntro}
<p>Fearless Safeguard is a Discord verification and server security service operated for the No Swipe RP community. This policy describes how information is processed during verification.</p>
<h2>Information processed</h2><ul><li>Discord user ID and username.</li><li>Discord server membership list, obtained with your OAuth2 authorization.</li><li>Verification status, timestamps, and relevant moderation or security events.</li><li>Limited technical request information that may be processed by our hosting provider.</li></ul>
<h2>How information is used</h2><p>We use this information to check eligibility against restricted Discord server IDs, assign verified roles, manage new-member verification, maintain moderation records, prevent abuse, and troubleshoot the service. We do not request your Discord password or sell verification information for advertising.</p>
<h2>Discord authorization</h2><p>We request Discord OAuth2 permissions for <strong>identify</strong> and <strong>guilds</strong>. You can revoke access in Discord's Authorized Apps settings. Revoking authorization does not automatically reverse completed moderation decisions.</p>
<h2>Sharing and retention</h2><p>Authorized No Swipe RP administrators may receive verification and moderation information. Discord and our hosting provider may process information required to deliver the service. Records are retained only as reasonably necessary for moderation, security, troubleshooting, and legal compliance. Actual retention may depend on operational logs and hosting configuration.</p>
<h2>Security</h2><p>We use reasonable access controls to protect bot credentials and verification information, but no internet service can guarantee absolute security.</p>
<h2>Your requests</h2><p>For questions, requests to access or delete eligible information, or appeals of verification decisions, contact No Swipe RP administrators through the community's official Discord support channels. Requests may require identity verification and may be subject to legitimate security or legal retention requirements.</p>
<h2>Age requirements and changes</h2><p>The service is intended for people eligible to use Discord under its terms and applicable law. This policy may change as our practices or legal obligations change; updated versions will show a revised effective date.</p>
<h2>Third parties</h2><p>This service uses Discord authorization and may be hosted on Render. Those services have their own privacy policies.</p>
</article>`)));
app.get('/terms', (req,res) => res.type('html').send(page('Terms of Service', `
<article class="panel"><div class="eyebrow">Fearless Safeguard</div><h1>Terms of Service</h1>${legalIntro}
<h2>Acceptance and eligibility</h2><p>By using Fearless Safeguard, you agree to these terms and the No Swipe RP community rules. You must be eligible to use Discord and comply with applicable laws and Discord's terms. You may decline verification, but doing so may prevent access to the community.</p>
<h2>Service description</h2><p>Fearless Safeguard provides Discord OAuth2 account verification, server-membership checks against restricted server IDs, automated verified-role assignment, new-member verification, and moderation logging.</p>
<h2>Verification requirements</h2><p>New members are asked to verify; no automatic timeout kicks are used. Verification requires authorization for Discord identity and server membership information. Failure to complete verification, refusal to authorize, or membership in a restricted server may result in denied access or removal from No Swipe RP.</p>
<h2>Prohibited behavior</h2><p>You must not bypass verification, impersonate users, abuse the service, exploit vulnerabilities, interfere with its operation, or access administrative features without authorization.</p>
<h2>Moderation and appeals</h2><p>No Swipe RP administration may restrict community access for legitimate moderation and security reasons, subject to applicable law and Discord's policies. Contact community administrators through official Discord support channels to request review of a verification decision.</p>
<h2>Availability</h2><p>The service is provided on an as-available basis. Hosting outages, maintenance, Discord API changes, or technical failures may interrupt access. To the extent permitted by law, the operators are not liable for indirect or consequential losses resulting from these interruptions.</p>
<h2>Privacy and third parties</h2><p>Our <a href="/privacy">Privacy Policy</a> describes how verification data is handled. The service uses Discord and may use third-party hosting. Fearless Safeguard is not endorsed by or affiliated with Discord.</p>
<h2>Changes and termination</h2><p>We may change verification rules or these terms when reasonably necessary to operate the community. You may stop using the service at any time; No Swipe RP may suspend or revoke access when verification or community rules are not met.</p>
<h2>Contact</h2><p>For questions or appeals, contact No Swipe RP administration through the community's official Discord support channels.</p>
</article>`)));
const resultPage = (heading, message, ok=false) => page(heading, `<section class="hero panel"><div class="eyebrow">${ok?'Verification complete':'Verification notice'}</div><h1>${htmlEscape(heading)}</h1><p class="lead">${htmlEscape(message)}</p><a class="button" href="/">Return to homepage</a></section>`);

app.get('/verify',(req,res)=>res.redirect(302,'/'));
app.get('/authorize',(req,res)=>{const state=crypto.randomBytes(32).toString('hex');states.set(state,Date.now()+300000);const q=new URLSearchParams({client_id:cfg.CLIENT_ID,redirect_uri:`${base}/callback`,response_type:'code',scope:'identify guilds',state,prompt:'consent'});res.redirect(`https://discord.com/oauth2/authorize?${q}`)});
app.get('/callback',async(req,res)=>{if(!storageReady)return res.status(503).type('html').send(resultPage('Verification unavailable','Security database is not ready. Please try again shortly.'));const {code,state}=req.query;const expires=states.get(state);states.delete(state);if(!code||!expires||expires<Date.now())return res.status(400).type('html').send(resultPage('Verification expired', 'Please return to the homepage and try again.'));try{const body=new URLSearchParams({client_id:cfg.CLIENT_ID,client_secret:cfg.CLIENT_SECRET,grant_type:'authorization_code',code:String(code),redirect_uri:`${base}/callback`});const t=await fetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});if(!t.ok)throw Error('Token exchange failed');const token=(await t.json()).access_token;const headers={Authorization:`Bearer ${token}`};const [u,g]=await Promise.all([fetch('https://discord.com/api/users/@me',{headers}),fetch('https://discord.com/api/users/@me/guilds?limit=200',{headers})]);if(!u.ok||!g.ok)throw Error('Discord membership check failed');const user=await u.json();const guilds=await g.json();const guild=await bot.guilds.fetch(cfg.GUILD_ID);const member=await guild.members.fetch(user.id).catch(()=>null);if(!member)return res.status(403).type('html').send(resultPage('Join the server first', 'Join the No Swipe RP Discord server before verifying.'));const restrictions=await blockedIds();console.log(`[Safeguard] OAuth ${user.id}: ${guilds.length} guilds; ${restrictions.length} blocked IDs`);if(restrictions.length===0)throw Error('Restricted server list is empty; verification is disabled until configured');const matched=guilds.filter(x=>restrictions.includes(String(x.id))).map(x=>x.id);if(matched.length){console.log(`[Safeguard] ${user.id} matched ${matched.length} restricted servers`);const eligible=await isRecordedNewJoin(member);
if(!eligible || member.roles.cache.has(cfg.VERIFIED_ROLE_ID)) {
  console.warn(`[Safeguard] Restricted match for ${user.id}, but protected existing/verified member; no kick.`);
  await logEvent({title:'Restricted match — existing member protected',color:0xf59e0b,member,reason:'Membership in a blocked Discord server',blockedIds:matched,outcome:'No kick: member not registered as a new, unverified join'});
  return res.status(403).type('html').send(resultPage('Verification rejected — no removal','This account did not meet the restricted-server requirements. Existing members are protected from automated removal. Contact a moderator.'));
}
const kicked=await kick(member,'Membership in a blocked Discord server',matched);return res.status(403).type('html').send(resultPage(kicked?'Verification unsuccessful — removed':'Verification rejected — manual review required',kicked?'Your account did not meet the server membership requirements and has been removed.':'Your account did not meet the server membership requirements. Removal is disabled or unavailable; contact a moderator.'));}await member.roles.add(cfg.VERIFIED_ROLE_ID,'Passed OAuth2 membership verification');if(await isRecordedNewJoin(member)) await clearNewJoin(user.id);await logEvent({title:'Verification Successful',color:0x22c55e,member,reason:'Passed OAuth2 membership verification',outcome:'Verified role assigned'});return res.type('html').send(resultPage('Verification successful!', 'Your Discord account has been verified. You can now return to Discord.', true));}catch(e){console.error(e);return res.status(503).type('html').send(resultPage('Verification unavailable', 'Could not complete verification right now. Please try again.'));}});
app.listen(Number(cfg.PORT||3000),()=>console.log('Verification web server listening'));
bot.login(cfg.DISCORD_TOKEN);






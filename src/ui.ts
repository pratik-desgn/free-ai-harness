const shell = (body: string, script = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Harness</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#080b10;color:#edf3f8}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 0,#16253a 0,#080b10 45%)}
main{width:min(860px,calc(100% - 32px));padding:32px;border:1px solid #273444;border-radius:20px;background:#0d131bcc;box-shadow:0 24px 80px #0008}
h1{font-size:28px;margin:0 0 8px}.muted{color:#91a3b5;margin:0 0 24px}textarea,input{width:100%;padding:14px 16px;border-radius:12px;border:1px solid #34465a;background:#090e14;color:#fff;font:inherit}
textarea{min-height:180px;resize:vertical}button{margin-top:12px;padding:12px 18px;border:0;border-radius:12px;background:#48d597;color:#06120d;font-weight:750;cursor:pointer}button:disabled{opacity:.5}
#status{margin-top:20px;white-space:pre-wrap;line-height:1.5}.event{padding:8px 0;border-bottom:1px solid #1f2a36}.result{margin-top:18px;padding:18px;background:#090e14;border-radius:12px;white-space:pre-wrap}
.top{display:flex;align-items:start;justify-content:space-between;gap:16px}.ghost{margin:0;background:#1a2531;color:#cbd8e5}.providers{margin-top:32px;border-top:1px solid #273444;padding-top:20px}.provider{border:1px solid #273444;border-radius:12px;padding:14px;margin:10px 0}.provider summary{cursor:pointer;font-weight:650}.provider input{margin-top:10px}.badge{float:right;color:#48d597;font-size:13px}.danger{background:#542330;color:#ffdce4}.primary{width:100%;font-size:16px;padding:15px}.ready{display:flex;gap:10px;align-items:center;padding:14px 16px;border:1px solid #275a48;border-radius:12px;background:#0d211a;color:#baf8dd}.dot{width:9px;height:9px;border-radius:50%;background:#48d597;box-shadow:0 0 14px #48d597}.admin{margin-top:24px;color:#91a3b5}.admin summary{cursor:pointer}
</style></head><body><main>${body}</main><script>${script}</script></body></html>`;

export const loginHtml = shell(`
  <script src="https://js.puter.com/v2/"></script>
  <h1>One login. Every model.</h1>
  <p class="muted">Authorize once. The harness chooses from hundreds of models, manages capacity, and completes the workflow.</p>
  <button class="primary" id="puter-login">Continue with Universal AI</button>
  <p class="muted">Uses your Puter allowance. In free-only mode the harness checks it and blocks once Puter reports it exhausted; Puter's own billing controls remain authoritative. Requests follow Puter and the selected model provider's privacy terms.</p>
  <p class="admin">By continuing you accept the <a href="/terms">terms</a> and acknowledge the <a href="/privacy">privacy notice</a>.</p>
  <p class="admin"><a href="/admin/login">Administrator access</a></p>
  <div id="status"></div>
`, `
document.querySelector('#puter-login').addEventListener('click',async()=>{const status=document.querySelector('#status'),button=document.querySelector('#puter-login');button.disabled=true;status.textContent='Opening secure authorization…';try{await puter.auth.signIn();const user=await puter.auth.getUser();const token=puter.authToken;if(!token)throw new Error('Authorization did not return a credential');status.textContent='Activating your AI capacity…';const response=await fetch('/auth/puter',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,displayName:user.username||user.email||'AI user'})});const body=await response.json();if(!response.ok)throw new Error(body.error?.message||'Could not activate AI');location.reload();}catch(error){status.textContent=error.msg||error.message||'Authorization cancelled';button.disabled=false;}});
`);

export const adminLoginHtml = shell(`
  <h1>Administrator access</h1>
  <p class="muted">This isolated page loads no third-party authentication scripts.</p>
  <form id="login"><input id="password" type="password" autocomplete="current-password" placeholder="Harness password" required><button>Continue as administrator</button></form>
  <p class="admin"><a href="/">Back to user sign-in</a></p><div id="status"></div>
`, `
document.querySelector('#login').addEventListener('submit',async(e)=>{e.preventDefault();const status=document.querySelector('#status');status.textContent='Signing in…';const response=await fetch('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.querySelector('#password').value})});if(response.ok)location.href='/';else status.textContent='Login failed';});
`);

export const privacyHtml = shell(`
  <h1>Privacy</h1>
  <p class="muted">This is a self-hosted AI gateway. The operator of this instance controls the data stored here; the open-source project does not receive it automatically.</p>
  <h2>What this instance stores</h2><p>It may retain an opaque Puter identity, encrypted provider authorization, session hashes, workflows and model responses, tool events, feedback, usage measurements, and files deliberately created in your isolated workspace.</p>
  <h2>Where requests go</h2><p>Your prompt is sent to Puter or the automatically selected provider to fulfill the request and is governed by that provider's terms. Provider credentials are encrypted at rest and are not returned by the API.</p>
  <h2>Retention and control</h2><p>Completed history is retained for the configured period, 30 days by default. You can export the documented retained summary, disconnect Puter, or delete your live account and workspace. Existing encrypted backups remain until the instance operator's backup-retention window expires.</p>
  <p class="admin"><a href="/">Back</a> · <a href="https://github.com/pratik-desgn/free-ai-harness/blob/master/PRIVACY.md" rel="noreferrer">Full privacy notice</a></p>
`);

export const termsHtml = shell(`
  <h1>Terms and acceptable use</h1>
  <p class="muted">This instance and its models are provided without a guarantee of availability, output quality, or free quota.</p>
  <p>Follow applicable law and every selected provider's terms. Do not automate account creation, share credentials, bypass quotas or billing, access systems without authorization, harm other users, or submit sensitive data unless this instance and its providers are approved for it.</p>
  <p>Providers independently control allowance, pricing, privacy, and suspension. Puter billing controls are authoritative; harness limits are safety rails, not billing guarantees.</p>
  <p class="admin"><a href="/">Back</a> · <a href="https://github.com/pratik-desgn/free-ai-harness/blob/master/TERMS.md" rel="noreferrer">Full terms</a></p>
`);

export const dashboardHtml = shell(`
  <div class="top"><div><h1 id="welcome">What should we accomplish?</h1>
  <p class="muted">No model picker. The harness plans, routes, uses tools, and continues until the objective is complete.</p></div><button class="ghost" id="logout">Log out</button></div>
  <div class="ready"><span class="dot"></span><span><strong>AI ready</strong> · capacity and model selection are automatic</span></div>
  <form id="run"><textarea id="objective" placeholder="Describe the outcome you want…" required></textarea><button id="start">Start workflow</button></form>
  <div id="status"></div><div id="result"></div>
  <section class="providers"><h2>Recent workflows</h2><div id="runs">Loading…</div></section>
  <section class="providers"><h2>AI capacity</h2><p class="muted">Your available models are combined into one automatic pool.</p><div id="providers">Loading…</div></section>
  <section class="providers"><h2>Usage</h2><div id="usage">Loading…</div></section>
  <section class="providers" id="account"><h2>Your data</h2><p class="muted">Export up to 200 recent retained workflows plus an aggregate usage summary, disconnect AI access, or permanently delete your harness account and workspace.</p><a href="/v1/account/export">Export retained summary</a><br><button class="ghost" id="disconnect-puter">Disconnect Universal AI</button> <button class="danger" id="delete-account">Delete account</button></section>
`, `
const status=document.querySelector('#status'),result=document.querySelector('#result'),button=document.querySelector('#start');
async function loadMe(){const me=await (await fetch('/auth/me')).json();if(me.user?.displayName&&me.user.displayName!=='Administrator')document.querySelector('#welcome').textContent='What should we accomplish, '+me.user.displayName+'?';if(me.user?.provider==='operator')document.querySelector('#account').hidden=true;}
document.querySelector('#logout').addEventListener('click',async()=>{await fetch('/auth/logout',{method:'POST'});location.reload();});
document.querySelector('#disconnect-puter').addEventListener('click',async()=>{if(!confirm('Disconnect Universal AI from this harness?'))return;const response=await fetch('/v1/user-providers/puter',{method:'DELETE'});const body=await response.json();if(response.ok)location.reload();else alert(body.error?.message||'Could not disconnect');});
document.querySelector('#delete-account').addEventListener('click',async()=>{if(prompt('Type DELETE to permanently remove your harness data')!=='DELETE')return;const response=await fetch('/v1/account',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({confirmation:'DELETE'})});const body=await response.json();if(response.ok)location.reload();else alert(body.error?.message||'Could not delete account');});
document.querySelector('#run').addEventListener('submit',async(e)=>{e.preventDefault();button.disabled=true;status.textContent='Creating workflow…';result.textContent='';const response=await fetch('/v1/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({objective:document.querySelector('#objective').value})});const run=await response.json();if(!response.ok){status.textContent=run.error?.message||'Could not start';button.disabled=false;return;}await loadRuns();await poll(run.id);});
async function poll(id){const response=await fetch('/v1/runs/'+id),run=await response.json();status.innerHTML=run.events.map(e=>'<div class="event">'+escapeHtml(e.message)+'</div>').join('');if(run.status==='completed'){result.className='result';result.textContent=run.result;const feedback=document.createElement('div');feedback.innerHTML='<button class="ghost" data-rating="1">Useful</button> <button class="ghost" data-rating="-1">Needs work</button>';feedback.querySelectorAll('button').forEach(item=>item.addEventListener('click',async()=>{await fetch('/v1/runs/'+id+'/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({rating:Number(item.dataset.rating)})});feedback.textContent='Feedback saved';}));result.appendChild(feedback);button.disabled=false;return;}if(run.status==='failed'){result.className='result';result.textContent=run.error;button.disabled=false;return;}setTimeout(()=>poll(id),1000);}
function escapeHtml(value){const node=document.createElement('div');node.textContent=value;return node.innerHTML;}
async function loadProviders(){const response=await fetch('/v1/providers'),payload=await response.json(),root=document.querySelector('#providers');root.innerHTML=payload.data.map(p=>'<details class="provider"><summary>'+escapeHtml(p.label)+'<span class="badge">'+(p.unavailable?'No API':p.connected?'Connected':'Connect once')+'</span></summary><p class="muted">'+escapeHtml(p.description)+'</p>'+(p.reason?'<p class="muted">'+escapeHtml(p.reason)+'</p>':'')+(p.catalog?'<p class="muted">Health: '+(p.catalog.healthy?'ready':'unavailable')+' · '+p.catalog.availableModels.length+' models discovered</p>':'')+(p.managed?'':providerForm(p))+'</details>').join('');root.querySelectorAll('form').forEach(form=>form.addEventListener('submit',connectProvider));root.querySelectorAll('[data-disconnect]').forEach(item=>item.addEventListener('click',disconnectProvider));}
function providerForm(p){if(p.connected)return '<button class="danger" type="button" data-disconnect="'+p.id+'">Disconnect</button>';return (p.setupUrl?'<p><a href="'+escapeHtml(p.setupUrl)+'" target="_blank" rel="noreferrer">Get API key from provider ↗</a></p>':'')+'<form data-provider="'+p.id+'">'+p.fields.map(f=>'<input name="'+f.env+'" type="'+(f.secret?'password':'text')+'" placeholder="'+escapeHtml(f.label)+'" required autocomplete="off">').join('')+'<button>Connect</button></form>';}
async function connectProvider(e){e.preventDefault();const form=e.currentTarget,credentials=Object.fromEntries(new FormData(form));const response=await fetch('/v1/providers/'+form.dataset.provider,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({credentials})});if(!response.ok){const body=await response.json();alert(body.error?.message||'Connection failed');return;}await loadProviders();}
async function disconnectProvider(e){await fetch('/v1/providers/'+e.currentTarget.dataset.disconnect,{method:'DELETE'});await loadProviders();}
loadMe();loadProviders();
async function loadRuns(){const payload=await (await fetch('/v1/runs?limit=10')).json(),root=document.querySelector('#runs');root.innerHTML=payload.data.length?payload.data.map(run=>'<div class="provider" data-run="'+run.id+'"><strong>'+escapeHtml(run.objective.slice(0,90))+'</strong><span class="badge">'+run.status+'</span></div>').join(''):'No workflows yet';root.querySelectorAll('[data-run]').forEach(item=>item.addEventListener('click',()=>poll(item.dataset.run)));}
async function loadUsage(){const payload=await (await fetch('/v1/usage?days=30')).json(),root=document.querySelector('#usage');root.innerHTML=payload.data.length?payload.data.map(row=>'<div class="provider"><strong>'+escapeHtml(row.provider_id)+'</strong> · '+row.requests+' requests · '+row.total_tokens+' tokens · '+row.average_latency_ms+' ms average</div>').join(''):'No usage recorded yet';}
loadRuns();loadUsage();
`);

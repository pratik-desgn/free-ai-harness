const shell = (body: string, script = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Harness</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#080b10;color:#edf3f8}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 0,#16253a 0,#080b10 45%)}
main{width:min(760px,calc(100% - 32px));padding:32px;border:1px solid #273444;border-radius:20px;background:#0d131bcc;box-shadow:0 24px 80px #0008}
h1{font-size:28px;margin:0 0 8px}.muted{color:#91a3b5;margin:0 0 24px}textarea,input{width:100%;padding:14px 16px;border-radius:12px;border:1px solid #34465a;background:#090e14;color:#fff;font:inherit}
textarea{min-height:180px;resize:vertical}button{margin-top:12px;padding:12px 18px;border:0;border-radius:12px;background:#48d597;color:#06120d;font-weight:750;cursor:pointer}button:disabled{opacity:.5}
#status{margin-top:20px;white-space:pre-wrap;line-height:1.5}.event{padding:8px 0;border-bottom:1px solid #1f2a36}.result{margin-top:18px;padding:18px;background:#090e14;border-radius:12px;white-space:pre-wrap}
</style></head><body><main>${body}</main><script>${script}</script></body></html>`;

export const loginHtml = shell(`
  <h1>One login. Every model.</h1>
  <p class="muted">The harness chooses and coordinates the models for you.</p>
  <form id="login"><input id="password" type="password" autocomplete="current-password" placeholder="Harness password" required><button>Continue</button></form>
  <div id="status"></div>
`, `
document.querySelector('#login').addEventListener('submit',async(e)=>{e.preventDefault();const status=document.querySelector('#status');status.textContent='Signing in…';const response=await fetch('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.querySelector('#password').value})});if(response.ok)location.reload();else status.textContent='Login failed';});
`);

export const dashboardHtml = shell(`
  <h1>What should we accomplish?</h1>
  <p class="muted">No model picker. The harness plans, routes, uses tools, and continues until the objective is complete.</p>
  <form id="run"><textarea id="objective" placeholder="Describe the outcome you want…" required></textarea><button id="start">Start workflow</button></form>
  <div id="status"></div><div id="result"></div>
`, `
const status=document.querySelector('#status'),result=document.querySelector('#result'),button=document.querySelector('#start');
document.querySelector('#run').addEventListener('submit',async(e)=>{e.preventDefault();button.disabled=true;status.textContent='Creating workflow…';result.textContent='';const response=await fetch('/v1/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({objective:document.querySelector('#objective').value})});const run=await response.json();if(!response.ok){status.textContent=run.error?.message||'Could not start';button.disabled=false;return;}await poll(run.id);});
async function poll(id){const response=await fetch('/v1/runs/'+id),run=await response.json();status.innerHTML=run.events.map(e=>'<div class="event">'+escapeHtml(e.message)+'</div>').join('');if(run.status==='completed'){result.className='result';result.textContent=run.result;button.disabled=false;return;}if(run.status==='failed'){result.className='result';result.textContent=run.error;button.disabled=false;return;}setTimeout(()=>poll(id),1000);}
function escapeHtml(value){const node=document.createElement('div');node.textContent=value;return node.innerHTML;}
`);

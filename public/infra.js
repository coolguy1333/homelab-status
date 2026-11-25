'use strict';
/* Infrastructure section: Proxmox hosts and containers as reported by the connector agents.
   Loaded after app.js and uses its helpers ($, esc, api, toast, duration, ago, fmtDate, bytes). */

const Infra = (() => {
  const st = { data: null, error: null, drafts: {}, open: new Set(), busy: false };

  async function load(d) {
    if (!d || !d.authed || !d.infra || d.locked) { st.data = null; return; }
    try { st.data = await api('api/infra'); st.error = null; } catch (err) { st.error = err.message; }
  }

  // Problems for the big status banner at the top.
  function problems() {
    if (!st.data) return [];
    const out = [];
    for (const a of st.data.agents) {
      if (!a.configured) continue;
      if (!a.online) { out.push(`${a.name} offline`); continue; }
      const r = a.report || {};
      const down = (r.containers || []).filter(c => c.onboot && c.status !== 'running').length;
      if (down) out.push(`${down} container${down > 1 ? 's' : ''} down on ${r.host && r.host.node || a.name}`);
      const waiting = (r.pending || []).filter(p => !a.decisions[p.id]).length;
      if (waiting) out.push(`${waiting} approval${waiting > 1 ? 's' : ''} waiting`);
    }
    return out;
  }

  const pctBar = (used, total) => {
    if (!total) return '<span class="muted">—</span>';
    const p = Math.min(100, (used / total) * 100);
    const cls = p >= 90 ? 'bad' : p >= 75 ? 'warn' : '';
    return `<span class="meter ${cls}" title="${esc(`${bytes(used)} / ${bytes(total)}`)}"><span style="width:${p.toFixed(1)}%"></span></span><span class="meter-txt">${p.toFixed(0)}%</span>`;
  };

  const levelTag = l => `<span class="tag ${l === 'error' ? 'down' : l === 'warn' ? 'restart' : 'up'}">${esc(l || 'info')}</span>`;

  const taskTag = s => {
    const cls = { done: 'up', failed: 'down', running: 'restart', queued: 'restart', cancelled: '' }[s] || '';
    return `<span class="tag ${cls}">${esc(s)}</span>`;
  };

  function details(key, summary, body, extraCls = '') {
    return `<details class="${extraCls}" data-key="${esc(key)}"${st.open.has(key) ? ' open' : ''}><summary>${summary}</summary>${body}</details>`;
  }

  function hostBlock(a, r) {
    const h = r.host || {};
    const mem = h.memory || {};
    const storage = (h.storage || []).map(s => `<div class="kv"><span>${esc(s.name)} <span class="muted">${esc(s.type)}</span></span>${pctBar(s.used, s.total)}</div>`).join('');
    const upd = h.updates || {};
    return `
      <div class="infra-host">
        <div class="kv"><span>CPU</span>${pctBar((h.cpu || 0) * 100, 100)}</div>
        <div class="kv"><span>Memory</span>${pctBar(mem.used, mem.total)}</div>
        ${storage}
      </div>
      <div class="meta">
        <span>Proxmox <b>${esc(h.pveVersion || '?')}</b></span>
        <span>Kernel <b>${esc(h.kernel || '?')}</b></span>
        <span>Host uptime <b>${h.uptime ? duration(h.uptime) : '—'}</b></span>
        ${h.loadavg ? `<span>Load <b>${esc(h.loadavg.join(' / '))}</b></span>` : ''}
        <span>Host updates <b>${upd.count == null ? '—' : upd.count}</b>${upd.security ? ` <span class="pct-bad">(${upd.security} security)</span>` : ''}${upd.checkedAt ? ` <span class="muted">checked ${esc(ago(upd.checkedAt))}</span>` : ''}</span>
        ${h.rebootRequired ? '<span class="pct-warn"><b>Host reboot needed</b></span>' : ''}
      </div>`;
  }

  function containerTable(r) {
    const rows = (r.containers || []).slice().sort((x, y) => x.vmid - y.vmid).map(c => {
      const running = c.status === 'running';
      const dotCls = running ? 'up' : c.onboot ? 'down' : '';
      const u = c.updates || {};
      const lu = c.lastUpdate;
      const luTxt = lu ? `<span class="${lu.result === 'ok' ? 'pct-good' : lu.result === 'rolled-back' || lu.result === 'failed' ? 'pct-bad' : 'pct-warn'}" title="${esc(lu.msg || '')}">${esc(lu.result)}</span> <span class="muted">${esc(ago(lu.t))}</span>` : '<span class="muted">—</span>';
      return `<tr>
        <td class="num">${c.vmid}</td>
        <td><span class="dot ${dotCls} inline"></span>${esc(c.name)}${c.self ? ' <span class="muted">(agent)</span>' : ''}</td>
        <td>${running ? `${((c.cpu || 0) * 100).toFixed(0)}%` : `<span class="${c.onboot ? 'pct-bad' : 'muted'}">${esc(c.status)}</span>`}</td>
        <td>${running ? pctBar(c.mem, c.maxmem) : ''}</td>
        <td>${pctBar(c.disk, c.maxdisk)}</td>
        <td class="num">${running ? duration(c.uptime || 0) : ''}</td>
        <td class="num">${u.count == null ? '—' : u.count}${u.security ? ` <span class="pct-bad">(${u.security}s)</span>` : ''}</td>
        <td>${luTxt}</td>
      </tr>`;
    }).join('');
    return `<div class="table-wrap"><table class="ctable">
      <thead><tr><th>ID</th><th>Container</th><th>CPU</th><th>Memory</th><th>Disk</th><th>Uptime</th><th>Updates</th><th>Last update</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="muted">No containers reported</td></tr>'}</tbody></table></div>`;
  }

  function pendingBlock(a, r) {
    const items = (r.pending || []).map(p => {
      const d = a.decisions[p.id];
      const state = d ? `<span class="muted">${d.decision === 'approve' ? 'Approved' : 'Denied'} by ${esc(d.by)} ${esc(ago(d.at))} — ${d.acked ? 'agent is working on it' : 'waiting for the agent to pick it up'}</span>`
        : `<button class="btn small primary" data-infra="approve" data-agent="${esc(a.name)}" data-id="${esc(p.id)}">Approve</button>
           <button class="btn small danger" data-infra="deny" data-agent="${esc(a.name)}" data-id="${esc(p.id)}">Deny</button>`;
      return `<div class="pending-item">
        <div class="pending-head"><b>${esc(p.summary)}</b><span class="muted">${esc(p.kind || '')} · ${esc(ago(p.t))}</span></div>
        ${p.details ? details(`pd:${a.name}:${p.id}`, 'Details', `<pre>${esc(p.details)}</pre>`) : ''}
        <div class="pending-actions">${state}</div>
      </div>`;
    }).join('');
    if (!items) return '';
    return `<div class="infra-block pending"><h3>Waiting for your approval</h3>${items}</div>`;
  }

  function eventsBlock(a, r) {
    const ev = (r.events || []).slice().reverse();
    if (!ev.length) return '';
    const li = ev.slice(0, 60).map(e => `<li><time>${esc(fmtDate(e.t))}</time>${levelTag(e.level)}<span>${esc(e.msg)}</span></li>`).join('');
    const recentBad = ev.filter(e => e.level !== 'info' && Date.now() - e.t < 86400e3).length;
    return details(`ev:${a.name}`, `Activity log${recentBad ? ` <span class="pct-bad">(${recentBad} warning${recentBad > 1 ? 's' : ''} in 24h)</span>` : ''}`, `<ul class="events">${li}</ul>`, 'infra-block');
  }

  function runsBlock(a, r) {
    const runs = (r.updateRuns || []).slice().reverse();
    if (!runs.length) return '';
    const li = runs.slice(0, 10).map(u => `<li><time>${esc(fmtDate(u.t))}</time>${levelTag(u.level)}<span>${esc(u.summary)}</span></li>`).join('');
    return details(`ur:${a.name}`, `Update runs <span class="muted">· last ${esc(ago(runs[0].t))}</span>`, `<ul class="events">${li}</ul>`, 'infra-block');
  }

  function tasksBlock(a) {
    const key = a.name;
    const list = (a.tasks || []).slice(0, 15).map(t => `
      <li class="task">
        <div class="task-head">${taskTag(t.status)}<span class="task-text">${esc(t.text)}</span>
          <span class="muted">${esc(t.by || '')} · ${esc(ago(t.createdAt))}</span>
          ${t.status === 'queued' ? `<button class="btn small ghost" data-infra="cancel" data-agent="${esc(a.name)}" data-id="${esc(t.id)}">Cancel</button>` : ''}
        </div>
        ${t.output ? details(`to:${a.name}:${t.id}`, t.status === 'running' ? 'Progress' : 'Answer', `<pre>${esc(t.output)}</pre>`) : ''}
      </li>`).join('');
    return `<div class="infra-block">
      <h3>Ask ${esc(a.name)}</h3>
      <form class="task-form" data-agent="${esc(a.name)}">
        <textarea name="text" rows="2" maxlength="4000" placeholder="e.g. Why is AMPServer2 using so much memory? / Fix Pi-Hole, DNS is not answering / Update ai now">${esc(st.drafts[key] || '')}</textarea>
        <button class="btn primary" type="submit">Send</button>
      </form>
      <p class="hint">The agent picks this up within 5 minutes and works on its own host with full access. Answers show up here.</p>
      ${list ? `<ul class="tasks">${list}</ul>` : ''}
    </div>`;
  }

  function agentCard(a) {
    const r = a.report || {};
    const h = r.host || {};
    const dot = !a.receivedAt ? 'pending' : a.online ? 'up' : 'down';
    const status = !a.receivedAt ? 'never reported' : a.online ? `reported ${ago(a.receivedAt)}` : `OFFLINE — last report ${ago(a.receivedAt)}`;
    const body = a.report ? `
      ${pendingBlock(a, r)}
      ${hostBlock(a, r)}
      ${containerTable(r)}
      ${runsBlock(a, r)}
      ${eventsBlock(a, r)}` : `<p class="muted">No report received from this agent yet.${a.configured ? '' : ' (Not in AGENT_TOKENS any more.)'}</p>`;
    return `<article class="card infra-card" data-agent="${esc(a.name)}">
      <div class="infra-head">
        <span class="dot ${dot}"></span>
        <div class="infra-title">
          <h3>${esc(h.node || a.name)} <span class="muted">· agent ${esc(a.name)}${h.ip ? ` · ${esc(h.ip)}` : ''}</span></h3>
          <div class="muted ${a.online ? '' : 'pct-bad'}">${esc(status)}${r.agentVersion ? ` · v${esc(r.agentVersion)}` : ''}</div>
        </div>
      </div>
      ${body}
      ${a.configured ? tasksBlock(a) : ''}
    </article>`;
  }

  function render(d) {
    const sec = $('#infraSection');
    if (!sec) return;
    const show = Boolean(d && d.authed && d.infra && !d.locked);
    sec.hidden = !show;
    if (!show) return;
    // Don't redraw under someone who is typing a task.
    const active = document.activeElement;
    if (active && active.closest && active.closest('#infraList') && active.matches('textarea, input')) return;
    if (st.error && !st.data) { $('#infraList').innerHTML = `<div class="card empty"><p class="pct-bad">${esc(st.error)}</p></div>`; return; }
    if (!st.data) {
      // The very first refresh can run before this file has loaded: fetch our part now.
      if (!st.loading) { st.loading = true; load(d).then(() => { st.loading = false; if (st.data) render(d); }); }
      return;
    }
    const agents = st.data.agents;
    $('#infraSub').textContent = `${agents.filter(a => a.online).length} of ${agents.length} agents online`;
    $('#infraList').innerHTML = agents.length ? agents.map(agentCard).join('') : '<div class="card empty"><p>No agents yet. Set AGENT_TOKENS.</p></div>';
  }

  // ---- events
  document.addEventListener('toggle', e => {
    const el = e.target;
    if (!(el instanceof HTMLDetailsElement) || !el.dataset.key) return;
    if (el.open) st.open.add(el.dataset.key); else st.open.delete(el.dataset.key);
  }, true);

  document.addEventListener('input', e => {
    const form = e.target.closest && e.target.closest('.task-form');
    if (form) st.drafts[form.dataset.agent] = e.target.value;
  });

  document.addEventListener('submit', async e => {
    const form = e.target.closest('.task-form');
    if (!form) return;
    e.preventDefault();
    const agent = form.dataset.agent;
    const text = form.text.value.trim();
    if (!text) return;
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api(`api/infra/${encodeURIComponent(agent)}/tasks`, { method: 'POST', body: { text } });
      st.drafts[agent] = '';
      form.text.value = '';
      form.text.blur();
      toast(`Sent to ${agent}. It will pick it up within 5 minutes.`);
      await load(state.data); render(state.data);
    } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
  });

  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-infra]');
    if (!btn) return;
    const { agent, id } = btn.dataset;
    const action = btn.dataset.infra;
    try {
      if (action === 'approve' || action === 'deny') {
        const item = btn.closest('.pending-item');
        const what = item ? item.querySelector('b').textContent : id;
        if (!confirm(`${action === 'approve' ? 'Approve' : 'Deny'}: ${what}?`)) return;
        btn.disabled = true;
        await api(`api/infra/${encodeURIComponent(agent)}/decision`, { method: 'POST', body: { id, decision: action } });
        toast(action === 'approve' ? `Approved. ${agent} acts on it within 5 minutes.` : 'Denied.');
      } else if (action === 'cancel') {
        await api(`api/infra/${encodeURIComponent(agent)}/tasks/${id}/cancel`, { method: 'POST', body: {} });
        toast('Task cancelled');
      }
      await load(state.data); render(state.data);
    } catch (err) { toast(err.message, true); }
  });

  return { load, render, problems };
})();

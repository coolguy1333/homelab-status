'use strict';
/* Homelab dashboard: navigation and the Overview / Containers / Updates / Backups / Ask / Activity pages,
   plus the internal-services part of Uptime. Data comes from /api/infra (agent reports).
   Loaded before app.js; uses its helpers ($, $$, esc, api, toast, duration, ago, fmtDate, bytes, pct,
   recentBars, daysBars, state) only inside functions. */

// Patch the DOM in place instead of replacing it, so refreshes don't reset scroll positions, text selection,
// focus, open <details>, or what you're typing. Elements with data-key/data-id/data-ct/data-chat/id are matched
// by that key; everything else by position.
function morph(el, html) {
  if (!el) return;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  morphChildren(el, tpl.content);
}
function morphKey(n) {
  if (n.nodeType !== 1) return null;
  return n.getAttribute('data-key') || n.getAttribute('data-id') || n.getAttribute('data-ct') || n.getAttribute('data-chat') || n.id || null;
}
function morphSame(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== 1) return true;
  return a.nodeName === b.nodeName && morphKey(a) === morphKey(b);
}
function morphChildren(from, to) {
  const keyed = new Map();
  for (const n of from.childNodes) { const k = morphKey(n); if (k) keyed.set(k, n); }
  const want = [...to.childNodes];
  for (let i = 0; i < want.length; i++) {
    const t = want[i];
    const k = morphKey(t);
    let cur = from.childNodes[i] || null;
    if (k && keyed.has(k)) {
      const m = keyed.get(k);
      keyed.delete(k);
      if (m !== cur) { from.insertBefore(m, cur); cur = m; }
    }
    if (cur && morphSame(cur, t)) morphNode(cur, t);
    else from.insertBefore(document.importNode(t, true), cur);
  }
  while (from.childNodes.length > want.length) from.removeChild(from.lastChild);
}
function morphNode(a, b) {
  if (a.nodeType !== 1) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
  const focused = a === document.activeElement;
  for (const { name } of [...a.attributes]) {
    if (!b.hasAttribute(name) && !(a.nodeName === 'DETAILS' && name === 'open')) a.removeAttribute(name);
  }
  for (const { name, value } of [...b.attributes]) {
    if (a.nodeName === 'DETAILS' && name === 'open') continue; // the user's open/closed choice wins
    if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  }
  if (a.nodeName === 'INPUT') {
    if (a.type === 'checkbox' || a.type === 'radio') a.checked = b.hasAttribute('checked');
    else if (!focused && a.value !== (b.getAttribute('value') || '')) a.value = b.getAttribute('value') || '';
    return;
  }
  if (a.nodeName === 'TEXTAREA') {
    if (!focused && a.value !== b.value && !a.dataset.dirty) a.value = b.value;
    return;
  }
  if (a.nodeName === 'SELECT' && focused) return;
  morphChildren(a, b);
}
// Don't redraw text the user is selecting (e.g. to copy an answer).
function selectingIn(el) {
  const sel = window.getSelection && window.getSelection();
  return Boolean(sel && !sel.isCollapsed && sel.anchorNode && el && el.contains(sel.anchorNode));
}

const Dash = (() => {
  const VIEWS = ['overview', 'containers', 'updates', 'backups', 'uptime', 'ask', 'activity'];
  const st = {
    data: null, error: null, loading: false,
    open: new Set(), expanded: new Set(), sel: new Map(), chatSel: {},
    drafts: {}, askAgent: null,
    filters: { host: '', status: '', q: '', level: '', ahost: '' },
  };

  // ------------------------------------------------------------ data
  async function load(d) {
    if (!d || !d.authed || !d.infra || d.locked) { st.data = null; return; }
    try { st.data = await api('api/infra'); st.error = null; } catch (err) { st.error = err.message; }
  }
  const enabled = d => Boolean(d && d.authed && d.infra && !d.locked);
  const agents = () => (st.data ? st.data.agents : []);
  const hostOf = a => (a.report && a.report.host && a.report.host.node) || a.name;
  function containers() {
    const out = [];
    for (const a of agents()) for (const c of ((a.report || {}).containers || [])) out.push({ ...c, host: hostOf(a), agent: a.name });
    return out;
  }
  const services = () => (st.data ? st.data.services || [] : []);
  const svcFor = (agent, vmid) => services().filter(s => s.agent === agent && s.vmid === vmid);
  const HOUR = 3600e3;
  const backupAge = c => (c.backup && c.backup.last ? Date.now() - c.backup.last.t : null);
  const backupState = c => {
    const b = c.backup || {};
    if (!b.covered) return b.last ? 'uncovered' : 'none';
    if (!b.last) return 'missing';
    const age = backupAge(c);
    return age < 26 * HOUR ? 'ok' : age < 72 * HOUR ? 'old' : 'stale';
  };

  // ------------------------------------------------------------ attention items
  function attention(d) {
    const items = [];
    const push = (level, text, view) => items.push({ level, text, view });
    for (const a of agents()) {
      if (!a.configured) continue;
      if (!a.receivedAt) push('err', `Agent ${a.name} has never reported`, 'overview');
      else if (!a.online) push('err', `Agent ${a.name} (${hostOf(a)}) offline — last report ${ago(a.receivedAt)}`, 'overview');
      const r = a.report || {};
      if (r.host && r.host.unreachable) push('err', `${a.name} cannot reach Proxmox host ${r.host.ip}`, 'overview');
      const waiting = (r.pending || []).filter(p => !a.decisions[p.id]);
      if (waiting.length) push('warn', `${waiting.length} item${waiting.length > 1 ? 's' : ''} waiting for your approval on ${hostOf(a)}`, 'updates');
      if (r.host && r.host.rebootRequired) push('info', `${hostOf(a)} needs a reboot to finish updates`, 'updates');
      for (const s of (r.host && r.host.storage) || []) if (s.total && s.used / s.total >= 0.9) push('warn', `${hostOf(a)} storage ${s.name} is ${Math.round(s.used / s.total * 100)}% full`, 'overview');
      const failed = ((r.backups && r.backups.tasks) || []).filter(t => t.status !== 'OK' && t.status !== 'running' && Date.now() - t.t < 24 * HOUR);
      if (failed.length) push('err', `${failed.length} backup run${failed.length > 1 ? 's' : ''} failed on ${hostOf(a)} in the last 24 h`, 'backups');
    }
    for (const p of pbsServers()) {
      if (!p.reachable) push('err', `Backup server ${p.storage} (${p.server}) is not reachable`, 'backups');
      if (p.verifyFailed) push('err', `${p.verifyFailed} backup(s) on ${p.storage} failed verification`, 'backups');
      if (p.total && p.used / p.total >= 0.85) push('warn', `Backup datastore ${p.datastore} is ${Math.round(p.used / p.total * 100)}% full`, 'backups');
      const dd = p.details;
      if (dd) {
        for (const g of dd.gc || []) if (g.state && !/^ok$/i.test(g.state)) push('warn', `Backup server garbage collection on ${g.store}: ${g.state}`, 'backups');
        for (const j of dd.jobs || []) if (j.state && !/^ok$/i.test(j.state)) push('warn', `Backup server ${j.type} job ${j.id}: ${j.state}`, 'backups');
      }
    }
    for (const c of containers()) {
      if (c.onboot && c.status !== 'running') push('err', `${c.name} (${c.vmid}) on ${c.host} is ${c.status}`, 'containers');
      const lu = c.lastUpdate;
      if (lu && (lu.result === 'rolled-back' || lu.result === 'failed') && Date.now() - lu.t < 48 * HOUR) push('err', `${c.name}: last update ${lu.result}`, 'updates');
      const bs = backupState(c);
      if (bs === 'missing' || bs === 'stale') push('warn', `${c.name}: ${bs === 'missing' ? 'no backup yet' : `last backup ${ago(c.backup.last.t)}`}`, 'backups');
      if (c.maxdisk && c.disk / c.maxdisk >= 0.9) push('warn', `${c.name} disk is ${Math.round(c.disk / c.maxdisk * 100)}% full`, 'containers');
    }
    const mDown = ((d && d.monitors) || []).filter(m => m.status === 'down');
    if (mDown.length) push('err', `${mDown.length} public site${mDown.length > 1 ? 's' : ''} down: ${mDown.slice(0, 3).map(m => m.name).join(', ')}${mDown.length > 3 ? '…' : ''}`, 'uptime');
    const sDown = services().filter(s => s.status === 'down' && !s.stale);
    if (sDown.length) push('err', `${sDown.length} internal service${sDown.length > 1 ? 's' : ''} down: ${sDown.slice(0, 3).map(s => `${s.container}${s.port ? `:${s.port}` : ' (no ping)'}`).join(', ')}`, 'uptime');
    const order = { err: 0, warn: 1, info: 2 };
    return items.sort((x, y) => order[x.level] - order[y.level]);
  }

  // ------------------------------------------------------------ Markdown (agent answers)
  // Small, safe renderer: everything is HTML-escaped first; only links to http(s) are kept.
  function mdInline(t) {
    const codes = [];
    let h = esc(t).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return h.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  }
  function md(src) {
    const lines = String(src || '').replace(/\r/g, '').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre>${esc(buf.join('\n'))}</pre>`);
        continue;
      }
      if (!line.trim()) { i++; continue; }
      let m;
      if ((m = line.match(/^\s*(#{1,6})\s+(.*)$/))) { const lv = Math.min(6, m[1].length + 2); out.push(`<h${lv}>${mdInline(m[2])}</h${lv}>`); i++; continue; }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
        const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const body = rows.filter(r => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
        const [head, ...rest] = body;
        out.push(`<div class="table-wrap"><table class="mdt"><thead><tr>${cells(head).map(c => `<th>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${rest.map(r => `<tr>${cells(r).map(c => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d/.test(line);
        const items = [];
        while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
          const l = lines[i++];
          const mm = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (mm) items.push({ depth: Math.floor(mm[1].replace(/\t/g, '  ').length / 2), text: mm[3] });
          else items[items.length - 1].text += ' ' + l.trim();
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map(it => `<li class="d${Math.min(it.depth, 3)}">${mdInline(it.text)}</li>`).join('')}</${tag}>`);
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|```|\||([-*+]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++].trim());
      if (para.length) out.push(`<p>${para.map(mdInline).join('<br>')}</p>`);
      else i++;
    }
    return `<div class="md">${out.join('')}</div>`;
  }

  // ------------------------------------------------------------ answers: usage line + hand-off plan
  const HANDOFF = /^#{1,3}\s*Handoff plan for Claude Code\s*$/im;
  const kTok = n => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0));
  const usageTotal = u => (u ? (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) : 0);
  function usageLine(u) {
    if (!u) return '';
    return `<span class="usage-line" title="${esc(`input ${u.input || 0} · output ${u.output || 0} · cache read ${u.cacheRead || 0} · cache write ${u.cacheWrite || 0}${u.model ? ` · ${u.model}` : ''}`)}">${kTok(usageTotal(u))} tokens${u.cost ? ` · $${Number(u.cost).toFixed(2)}` : ''}${u.turns ? ` · ${u.turns} step${u.turns > 1 ? 's' : ''}` : ''}${u.ms ? ` · ${duration(u.ms / 1000)}` : ''}</span>`;
  }
  function answer(output, id) {
    const text = String(output || '');
    const m = text.match(HANDOFF);
    if (!m) return md(text);
    const main = text.slice(0, m.index).trim();
    const plan = text.slice(m.index + m[0].length).trim();
    return `${main ? md(main) : ''}
      <div class="handoff">
        <div class="handoff-head"><b>⇢ Plan for Claude Code</b><span class="muted">The agent couldn't (or isn't allowed to) finish this. Paste the plan into Claude Code on your PC.</span>
          <button class="btn small primary" data-copy-plan="${esc(id)}">Copy plan</button></div>
        ${md(plan)}
      </div>`;
  }
  const plans = new Map(); // task id -> plan text for the copy button
  function rememberPlan(t) {
    const text = String(t.output || '');
    const m = text.match(HANDOFF);
    if (m) plans.set(t.id, `Fix this in my homelab. You can SSH to the connector containers over Tailscale (connector1 100.111.125.58 on host GOD 192.168.10.23, connector2 100.73.184.67 on host HELP 192.168.10.81) and from there reach the Proxmox hosts as root via the agent user's key.\n\nThe ${t.agentName || 'agent'} agent wrote this plan:\n\n${text.slice(m.index + m[0].length).trim()}`);
  }

  // ------------------------------------------------------------ small pieces
  const meter = (used, total, w = '') => {
    if (!total) return '<span class="muted">—</span>';
    const p = Math.max(0, Math.min(100, (used / total) * 100));
    const cls = p >= 90 ? 'bad' : p >= 75 ? 'warn' : '';
    return `<span class="mtr ${w}" title="${esc(`${bytes(used)} of ${bytes(total)}`)}"><span class="meter ${cls}"><span style="width:${p.toFixed(1)}%"></span></span><span class="meter-txt">${p.toFixed(0)}%</span></span>`;
  };
  const cpuMeter = v => meter((v || 0) * 1000, 1000);
  const tag = (cls, txt) => `<span class="tag ${cls}">${esc(txt)}</span>`;
  const levelTag = l => tag(l === 'error' ? 'down' : l === 'warn' ? 'restart' : 'up', l || 'info');
  const dot = cls => `<span class="dot inline ${cls}"></span>`;
  const empty = txt => `<div class="card empty"><p class="muted">${esc(txt)}</p></div>`;
  const pageHead = (title, sub, extra = '') => `<div class="page-head"><div><h2>${esc(title)}</h2>${sub ? `<p class="muted">${sub}</p>` : ''}</div>${extra}</div>`;
  function details(key, summary, body, cls = '') {
    return `<details class="${cls}" data-key="${esc(key)}"${st.open.has(key) ? ' open' : ''}><summary>${summary}</summary>${body}</details>`;
  }
  const kpi = (label, value, sub, cls = '', view = '') =>
    `<${view ? `a href="#${view}"` : 'div'} class="kpi ${cls}"><div class="kpi-k">${esc(label)}</div><div class="kpi-v">${value}</div><div class="kpi-s">${sub || ''}</div></${view ? 'a' : 'div'}>`;
  const ageCls = ms => (ms == null ? 'pct-bad' : ms < 26 * HOUR ? 'pct-good' : ms < 72 * HOUR ? 'pct-warn' : 'pct-bad');

  // ------------------------------------------------------------ Overview
  function viewOverview(d) {
    const att = attention(d);
    const cs = containers();
    const running = cs.filter(c => c.status === 'running').length;
    const mons = (d.monitors || []);
    const monsUp = mons.filter(m => m.status === 'up').length;
    const svcs = services().filter(s => !s.stale);
    const svcUp = svcs.filter(s => s.status === 'up').length;
    const upd = cs.reduce((n, c) => n + ((c.updates && c.updates.count) || 0), 0);
    const sec = cs.reduce((n, c) => n + ((c.updates && c.updates.security) || 0), 0);
    const covered = cs.filter(c => c.backup && c.backup.covered);
    const fresh = covered.filter(c => backupState(c) === 'ok').length;
    const ag = agents().filter(a => a.configured);
    const agOn = ag.filter(a => a.online).length;
    const approvals = ag.reduce((n, a) => n + ((a.report && a.report.pending) || []).filter(p => !a.decisions[p.id]).length, 0);

    const attHtml = att.length
      ? `<div class="card attention"><div class="att-head"><h3>Needs attention</h3><span class="muted">${att.length} item${att.length > 1 ? 's' : ''}</span></div>
          <ul class="att-list">${att.map(i => `<li class="att ${i.level}"><span class="att-ico">${i.level === 'err' ? '●' : i.level === 'warn' ? '▲' : 'i'}</span><a href="#${i.view}">${esc(i.text)}</a></li>`).join('')}</ul></div>`
      : `<div class="card attention ok"><span class="att-ok">✓</span><div><h3>Everything looks healthy</h3><p class="muted">All hosts reporting, containers running, backups fresh and sites up.</p></div></div>`;

    const kpis = `<div class="kpis">
      ${kpi('Containers', `${running}<span class="kpi-of">/${cs.length}</span>`, 'running', running < cs.filter(c => c.onboot).length ? 'bad' : '', 'containers')}
      ${kpi('Public sites', `${monsUp}<span class="kpi-of">/${mons.length}</span>`, 'up', mons.some(m => m.status === 'down') ? 'bad' : '', 'uptime')}
      ${kpi('Internal services', `${svcUp}<span class="kpi-of">/${svcs.length}</span>`, 'answering', svcUp < svcs.length ? 'bad' : '', 'uptime')}
      ${kpi('Updates pending', upd, sec ? `<span class="pct-bad">${sec} security</span> · nightly` : 'installed nightly', '', 'updates')}
      ${kpi('Approvals', approvals, approvals ? 'waiting for you' : 'nothing waiting', approvals ? 'warn' : '', 'updates')}
      ${kpi('Backups', `${fresh}<span class="kpi-of">/${covered.length}</span>`, 'fresh (< 26 h)', fresh < covered.length ? 'warn' : '', 'backups')}
      ${kpi('Agents', `${agOn}<span class="kpi-of">/${ag.length}</span>`, 'online', agOn < ag.length ? 'bad' : '', '')}
    </div>`;

    const hosts = `<div class="hosts">${ag.map(hostCard).join('')}${pbsServers().map(pbsCard).join('')}</div>`;
    const events = [];
    for (const a of agents()) for (const e of ((a.report || {}).events || [])) events.push({ ...e, host: hostOf(a) });
    events.sort((x, y) => y.t - x.t);
    const recent = events.slice(0, 8).map(e => `<li><time>${esc(ago(e.t))}</time>${levelTag(e.level)}<span><b>${esc(e.host)}</b> ${esc(e.msg)}</span></li>`).join('');
    return `${pageHead('Overview', '')}
      ${attHtml}${kpis}
      <h3 class="sec-title">Proxmox hosts</h3>${hosts}
      <div class="card pad"><div class="att-head"><h3>Recent activity</h3><a href="#activity">All activity →</a></div>
        ${recent ? `<ul class="events">${recent}</ul>` : '<p class="muted">Nothing yet.</p>'}</div>`;
  }

  // Backup servers (PBS) as the agents see them; both agents see the same one, keep the freshest.
  function pbsServers() {
    const m = new Map();
    for (const a of agents()) for (const p of ((a.report && a.report.backups && a.report.backups.pbs) || [])) {
      const k = `${p.server}/${p.datastore}`;
      if (!m.has(k) || (m.get(k).checkedAt || 0) < (p.checkedAt || 0)) m.set(k, { ...p, seenBy: a.name });
    }
    return [...m.values()];
  }

  function pbsDetails(d) {
    if (!d) return '<p class="hint">Add a read-only PBS API token to see garbage collection, verify jobs and the server\'s own health.</p>';
    const okState = v => !v || /^ok$/i.test(v);
    // PBS leaves last-run-state empty for some job types: fall back to the newest failed task for that job.
    const failedFor = id => (d.failedTasks || []).find(t => t.id && id && String(t.id).includes(id) && Date.now() - t.t < 48 * 3600e3);
    const jobs = [...(d.gc || []).map(g => ({ type: 'garbage collection', id: g.store, state: g.state, last: g.last, next: g.next })), ...(d.jobs || [])]
      .map(j => { if (j.state) return j; const f = failedFor(j.id); return f ? { ...j, state: `failed: ${f.status || 'error'}`, last: f.t } : j; });
    const recentFails = (d.failedTasks || []).filter(t => Date.now() - t.t < 7 * 86400e3);
    return `<div class="host-meters">
        <div class="kv"><span>CPU</span>${cpuMeter(d.cpu)}</div>
        <div class="kv"><span>Memory</span>${meter(d.memory && d.memory.used, d.memory && d.memory.total)}</div>
        <div class="kv"><span>System disk</span>${meter(d.root && d.root.used, d.root && d.root.total)}</div>
      </div>
      ${jobs.length ? `<div class="pbs-jobs">${jobs.map(j => `<div class="pj">
          <div class="pj-top">${dot(okState(j.state) ? 'up' : 'down')}<b>${esc(j.type)}</b><span class="pj-state ${okState(j.state) ? (j.state ? 'pct-good' : 'muted') : 'pct-bad'}">${esc(j.state || 'not run yet')}</span></div>
          <div class="pj-sub muted">${esc(j.id || '')}${j.last ? ` · last ${esc(ago(j.last))}` : ''}${j.next ? ` · next ${esc(fmtTime(j.next))}` : ''}</div>
        </div>`).join('')}</div>` : ''}
      ${recentFails.length ? details(`pbsfail`, `<span class="pct-bad">${recentFails.length} failed PBS task${recentFails.length > 1 ? 's' : ''} in the last 7 days</span>`, `<ul class="events">${recentFails.map(t => `<li><time>${esc(fmtDate(t.t))}</time>${tag('down', t.type || 'task')}<span>${esc(t.id || '')} — ${esc(t.status || '')}</span></li>`).join('')}</ul>`) : ''}
      <div class="meta"><span>PBS <b>${esc(d.version || '?')}</b></span>${d.uptime ? `<span>Up <b>${esc(duration(d.uptime).split(' ').slice(0, 2).join(' '))}</b></span>` : ''}</div>`;
  }

  function pbsCard(p) {
    const verPct = p.count ? Math.round((p.verifiedOk / p.count) * 100) : null;
    return `<div class="card host">
      <div class="host-head">${dot(p.reachable ? 'up' : 'down')}<div><h3>${esc(p.storage)} <span class="muted">${esc(p.server || '')}</span></h3>
        <div class="muted ${p.reachable ? '' : 'pct-bad'}">Proxmox Backup Server · datastore ${esc(p.datastore || '?')} · ${p.reachable ? `answering (${p.ms} ms)` : 'NOT REACHABLE'}</div></div>
        <span class="pill">backup server</span></div>
      <div class="host-meters"><div class="kv"><span>${esc(p.datastore || 'Datastore')}</span>${meter(p.used, p.total)}</div></div>
      <div class="pbs-stats">
        <div><b>${p.count}</b><span>backups</span></div>
        <div><b>${p.guests}</b><span>guests (${p.containers} CT · ${p.vms} VM)</span></div>
        <div><b>${p.last24h}</b><span>in last 24 h</span></div>
        <div><b class="${p.verifyFailed ? 'pct-bad' : verPct === 100 ? 'pct-good' : ''}">${verPct == null ? '—' : `${verPct}%`}</b><span>verified${p.verifyFailed ? ` · ${p.verifyFailed} failed` : ''}</span></div>
      </div>
      ${pbsDetails(p.details)}
      <div class="meta">
        <span>Newest <b>${p.last ? esc(ago(p.last)) : '—'}</b></span>
        <span>Oldest <b>${p.oldest ? esc(new Date(p.oldest).toLocaleDateString()) : '—'}</b></span>
        <span>Free <b>${p.avail ? bytes(p.avail) : '—'}</b></span>
        ${p.staleGuests ? `<span class="pct-warn">${p.staleGuests} guest(s) with no backup in 3 days</span>` : ''}
      </div>
    </div>`;
  }

  function hostCard(a) {
    const r = a.report || {};
    const h = r.host || {};
    const cs = r.containers || [];
    const st2 = !a.receivedAt ? 'pending' : a.online ? 'up' : 'down';
    const statusTxt = !a.receivedAt ? 'never reported' : a.online ? `reported ${ago(a.receivedAt)}` : `OFFLINE since ${ago(a.receivedAt)}`;
    if (!a.report) return `<div class="card host"><div class="host-head">${dot(st2)}<div><h3>${esc(a.name)}</h3><div class="muted">${esc(statusTxt)}</div></div></div><p class="muted">Waiting for the first report from this agent.</p></div>`;
    const storage = (h.storage || []).map(s => `<div class="kv"><span>${esc(s.name)}</span>${meter(s.used, s.total)}</div>`).join('');
    const chips = cs.slice().sort((x, y) => x.vmid - y.vmid).map(c => `<span class="chip" title="${esc(`${c.vmid} · ${c.status}`)}">${dot(c.status === 'running' ? 'up' : c.onboot ? 'down' : '')}${esc(c.name)}</span>`).join('');
    const upd = h.updates || {};
    const jobs = (r.backups && r.backups.jobs) || [];
    const next = jobs.map(j => j.nextRun).filter(Boolean).sort()[0];
    return `<div class="card host">
      <div class="host-head">${dot(st2)}<div><h3>${esc(h.node || a.name)} <span class="muted">${esc(h.ip || '')}</span></h3><div class="muted ${a.online ? '' : 'pct-bad'}">agent ${esc(a.name)} · ${esc(statusTxt)}</div></div>
        ${h.rebootRequired ? '<span class="pill warn">reboot needed</span>' : ''}</div>
      <div class="host-meters">
        <div class="kv"><span>CPU</span>${cpuMeter(h.cpu)}</div>
        <div class="kv"><span>Memory</span>${meter(h.memory && h.memory.used, h.memory && h.memory.total)}</div>
        ${storage}
      </div>
      <div class="chips">${chips}</div>
      <div class="meta">
        <span>PVE <b>${esc((h.pveVersion || '?').split('/')[0])}</b></span>
        <span>Up <b>${h.uptime ? duration(h.uptime).split(' ').slice(0, 2).join(' ') : '—'}</b></span>
        ${h.loadavg ? `<span>Load <b>${esc(h.loadavg.map(Number).map(n => n.toFixed(2)).join(' '))}</b></span>` : ''}
        <span>Host updates <b>${upd.count ?? '—'}</b></span>
        ${next ? `<span>Next backup <b>${esc(fmtTime(next))}</b></span>` : ''}
        ${r.schedule && r.schedule.updates ? `<span>Updates <b>nightly ${esc(r.schedule.updates)}</b></span>` : ''}
      </div>
    </div>`;
  }

  // ------------------------------------------------------------ Containers
  function hostFilter(key) {
    const hosts = [...new Set(agents().map(hostOf))];
    const cur = st.filters[key];
    return `<div class="seg" data-filter="${key}">${['', ...hosts].map(h => `<button class="${cur === h ? 'on' : ''}" data-val="${esc(h)}">${esc(h || 'All hosts')}</button>`).join('')}</div>`;
  }

  function viewContainers() {
    const f = st.filters;
    let cs = containers();
    if (f.host) cs = cs.filter(c => c.host === f.host);
    if (f.status === 'running') cs = cs.filter(c => c.status === 'running');
    if (f.status === 'problem') cs = cs.filter(c => (c.onboot && c.status !== 'running') || ['missing', 'stale'].includes(backupState(c)) || (c.lastUpdate && ['failed', 'rolled-back'].includes(c.lastUpdate.result)));
    if (f.q) { const q = f.q.toLowerCase(); cs = cs.filter(c => `${c.name} ${c.vmid} ${c.host}`.toLowerCase().includes(q)); }
    cs.sort((x, y) => x.host.localeCompare(y.host) || x.vmid - y.vmid);
    const rows = cs.map(c => {
      const id = `${c.agent}:${c.vmid}`;
      const open = st.expanded.has(id);
      const running = c.status === 'running';
      const sv = svcFor(c.agent, c.vmid);
      const svUp = sv.filter(s => s.status === 'up').length;
      const u = c.updates || {};
      const lu = c.lastUpdate;
      const age = backupAge(c);
      return `<tr class="crow${open ? ' open' : ''}" data-ct="${esc(id)}" tabindex="0">
        <td>${dot(running ? 'up' : c.onboot ? 'down' : '')}</td>
        <td class="num">${c.vmid}</td>
        <td><b>${esc(c.name)}</b>${c.self ? ' <span class="muted">agent</span>' : ''}</td>
        <td>${esc(c.host)}</td>
        <td>${running ? cpuMeter(c.cpu) : `<span class="${c.onboot ? 'pct-bad' : 'muted'}">${esc(c.status)}</span>`}</td>
        <td>${running ? meter(c.mem, c.maxmem) : ''}</td>
        <td>${meter(c.disk, c.maxdisk)}</td>
        <td class="num">${sv.length ? `<span class="${svUp < sv.length ? 'pct-bad' : ''}">${svUp}/${sv.length}</span>` : '<span class="muted">—</span>'}</td>
        <td class="num">${u.count == null ? '<span class="muted">—</span>' : u.count ? `${u.count}${u.security ? ` <span class="pct-bad">(${u.security}s)</span>` : ''}` : '<span class="pct-good">✓</span>'}</td>
        <td><span class="${ageCls(age)}">${age == null ? (c.backup && c.backup.covered ? 'none' : 'not backed up') : ago(c.backup.last.t)}</span></td>
        <td>${lu ? `<span class="${lu.result === 'ok' ? 'pct-good' : lu.result === 'held' ? 'pct-warn' : 'pct-bad'}">${esc(lu.result)}</span> <span class="muted">${esc(ago(lu.t))}</span>` : '<span class="muted">—</span>'}</td>
      </tr>${open ? `<tr class="cdetail"><td colspan="11">${containerDetail(c, sv)}</td></tr>` : ''}`;
    }).join('');
    return `${pageHead('Containers', `${cs.length} LXC container${cs.length === 1 ? '' : 's'} · click a row for details`)}
      <div class="toolbar">${hostFilter('host')}
        <div class="seg" data-filter="status">${[['', 'All'], ['running', 'Running'], ['problem', 'Problems']].map(([v, l]) => `<button class="${f.status === v ? 'on' : ''}" data-val="${v}">${l}</button>`).join('')}</div>
        <input type="search" class="search" data-filter-input="q" placeholder="Search containers…" value="${esc(f.q)}">
      </div>
      <div class="card table-card"><div class="table-wrap"><table class="ctable ct-containers">
        <thead><tr><th></th><th>ID</th><th>Name</th><th>Host</th><th>CPU</th><th>Memory</th><th>Disk</th><th>Services</th><th>Updates</th><th>Last backup</th><th>Last update</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="11" class="muted">No containers match.</td></tr>'}</tbody></table></div></div>`;
  }

  function containerDetail(c, sv) {
    const b = c.backup || {};
    const snaps = (c.snapshots || []).slice().sort((x, y) => y.t - x.t);
    const svc = sv.length ? `<table class="mini"><tbody>${sv.sort((x, y) => x.port - y.port).map(s => `<tr><td>${dot(s.status === 'up' ? 'up' : 'down')}${s.port ? `:${s.port}` : 'IP'}</td><td>${esc(s.proc || '')}</td><td class="muted">${esc(s.ip)}</td><td>${pct(s.uptime24h)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No listening services found.</p>';
    return `<div class="cd-grid">
      <div><h4>Services</h4>${svc}</div>
      <div><h4>Backups</h4>
        <div class="kvlist">
          <div><span>Covered by a job</span><b>${b.covered ? 'yes' : '<span class="pct-bad">no</span>'}</b></div>
          <div><span>Last backup</span><b>${b.last ? `${esc(fmtDate(b.last.t))} (${esc(ago(b.last.t))})` : '—'}</b></div>
          <div><span>Size</span><b>${b.last && b.last.size ? bytes(b.last.size) : '—'}</b></div>
          <div><span>Verified</span><b>${b.last ? esc(b.last.verified || 'not yet') : '—'}</b></div>
          <div><span>Backups kept</span><b>${b.count || 0}${b.size ? ` · ${bytes(b.size)}` : ''}</b></div>
        </div></div>
      <div><h4>Snapshots</h4>${snaps.length ? `<ul class="plain">${snaps.map(s => `<li><code>${esc(s.name)}</code> <span class="muted">${esc(fmtDate(s.t))}</span></li>`).join('')}</ul>` : '<p class="muted">None.</p>'}
        <h4>Updates</h4><p>${c.updates ? `${c.updates.count} pending${c.updates.security ? `, ${c.updates.security} security` : ''} · checked ${esc(ago(c.updates.checkedAt))}` : '<span class="muted">Not checked yet (nightly).</span>'}</p>
        ${c.lastUpdate ? `<p class="muted">Last: ${esc(c.lastUpdate.result)} — ${esc(c.lastUpdate.msg || '')}</p>` : ''}</div>
    </div>
    <div class="cd-actions">
      ${c.status === 'running'
        ? `<button class="btn small" data-act="reboot" data-agent="${esc(c.agent)}" data-vmid="${c.vmid}" data-name="${esc(c.name)}">↻ Reboot</button>
           ${c.self ? '' : `<button class="btn small" data-act="shutdown" data-agent="${esc(c.agent)}" data-vmid="${c.vmid}" data-name="${esc(c.name)}">■ Shut down</button>`}`
        : `<button class="btn small primary" data-act="start" data-agent="${esc(c.agent)}" data-vmid="${c.vmid}" data-name="${esc(c.name)}">▶ Start</button>`}
      <button class="btn small" data-act="snapshot" data-agent="${esc(c.agent)}" data-vmid="${c.vmid}" data-name="${esc(c.name)}">◷ Snapshot</button>
      <button class="btn small" data-act="backup" data-agent="${esc(c.agent)}" data-vmid="${c.vmid}" data-name="${esc(c.name)}">⛁ Back up now</button>
      ${c.status === 'running' ? `<button class="btn small" data-act="check" data-agent="${esc(c.agent)}" data-vmid="${c.vmid}" data-name="${esc(c.name)}">⌕ Check for updates</button>
        <button class="btn small" data-act="update" data-agent="${esc(c.agent)}" data-vmid="${c.vmid}" data-name="${esc(c.name)}">⟳ Update now</button>` : ''}
      <span class="spacer"></span>
      <button class="btn small" data-ask="${esc(c.agent)}" data-prefill="${esc(`About ${c.name} (container ${c.vmid}) on ${c.host}: `)}">✦ Ask about ${esc(c.name)}</button>
    </div>
    ${actionLog(c.agent, c.vmid)}`;
  }

  // "Checking…/Updating…" while one of those actions is queued or running for the container.
  function busyNote(c) {
    const a = agents().find(x => x.name === c.agent);
    const t = ((a && a.tasks) || []).find(x => x.action && x.action.vmid === c.vmid && ['queued', 'running'].includes(x.status) && ['check', 'update'].includes(x.action.type));
    return t ? ` <span class="pill warn">${t.action.type === 'check' ? 'checking…' : 'updating…'}</span>` : '';
  }

  // Recent one-click actions for a container (or the host when vmid is null).
  function actionLog(agent, vmid) {
    const a = agents().find(x => x.name === agent);
    const acts = ((a && a.tasks) || []).filter(t => t.action && (t.action.vmid ?? null) === vmid).slice(0, 4);
    if (!acts.length) return '';
    return `<ul class="events act-log">${acts.map(t => `<li><time>${esc(ago(t.createdAt))}</time>${statusTag(t.status)}<span>${esc(t.text)} <span class="muted">by ${esc(t.by || '')}</span>${t.output && t.status !== 'queued' ? `<span class="muted"> — ${esc(t.output.split('\n').filter(Boolean).slice(-1)[0] || '').slice(0, 160)}</span>` : ''}</span></li>`).join('')}</ul>`;
  }

  // ------------------------------------------------------------ Updates
  function viewUpdates() {
    const ag = agents().filter(a => a.report);
    const pend = [];
    for (const a of ag) for (const p of (a.report.pending || [])) pend.push({ a, p });
    const pendHtml = pend.length ? pend.map(({ a, p }) => {
      const dec = a.decisions[p.id];
      const pk = p.packages || [];
      const selKey = `${a.name}:${p.id}`;
      if (pk.length && !st.sel.has(selKey)) st.sel.set(selKey, new Set(pk.map(x => x.name)));
      const sel = st.sel.get(selKey) || new Set();
      const nSec = pk.filter(x => x.security).length;
      const act = dec ? `<span class="muted">${dec.decision === 'approve' ? `Approved${dec.packages ? ` (${dec.packages.length} selected)` : ''}` : 'Denied'} by ${esc(dec.by)} ${esc(ago(dec.at))} — ${dec.acked ? 'agent is on it' : 'sending to the agent…'}</span>`
        : pk.length
          ? `<button class="btn small primary" data-decide="approve" data-agent="${esc(a.name)}" data-id="${esc(p.id)}" ${sel.size ? '' : 'disabled'}>${sel.size === pk.length ? `Approve all ${pk.length}` : `Approve ${sel.size} selected`}</button>
             <button class="btn small danger" data-decide="deny" data-agent="${esc(a.name)}" data-id="${esc(p.id)}">Deny</button>`
          : `<button class="btn small primary" data-decide="approve" data-agent="${esc(a.name)}" data-id="${esc(p.id)}">Approve</button>
             <button class="btn small danger" data-decide="deny" data-agent="${esc(a.name)}" data-id="${esc(p.id)}">Deny</button>`;
      const picker = pk.length && !dec ? `<div class="pkg-pick" data-sel="${esc(selKey)}">
          <div class="pkg-tools"><span class="muted">${sel.size} of ${pk.length} selected</span>
            <button class="linkbtn" data-pick="all">All</button>${nSec ? `<button class="linkbtn" data-pick="security">Security only (${nSec})</button>` : ''}<button class="linkbtn" data-pick="none">None</button></div>
          ${details(`pk:${selKey}`, 'Choose packages', `<div class="pkg-list">${pk.map(x => `<label class="pkg"><input type="checkbox" data-pkg="${esc(x.name)}" ${sel.has(x.name) ? 'checked' : ''}><span class="pkg-name">${esc(x.name)}</span>${x.security ? '<span class="tag down">security</span>' : ''}<span class="muted">${esc(x.old)} → ${esc(x.new)}</span></label>`).join('')}</div>`)}
        </div>` : '';
      return `<div class="card approval">
        <div class="ap-head"><span class="pill ${p.kind === 'host-reboot' ? 'bad' : p.kind === 'host-update' ? 'warn' : ''}">${esc({ 'host-update': 'host update', 'host-reboot': 'host reboot', 'risky-update': 'held update' }[p.kind] || p.kind)}</span>
          <b>${esc(p.summary)}</b><span class="muted">${esc(hostOf(a))} · ${esc(ago(p.t))}</span></div>
        ${picker}
        ${p.details ? details(`pd:${a.name}:${p.id}`, pk.length ? 'Why / full details' : 'Details', `<pre>${esc(p.details)}</pre>`) : ''}
        <div class="ap-actions">${act}</div></div>`;
    }).join('') : '<div class="card empty"><p class="muted">Nothing is waiting for approval.</p></div>';

    const sched = ag.map(a => {
      const runs = a.report.updateRuns || [];
      const last = runs[runs.length - 1];
      const hu = (a.report.host && a.report.host.updates) || {};
      return `<div class="card pad sched"><div class="host-head">${dot(a.online ? 'up' : 'down')}<div><h3>${esc(hostOf(a))}</h3>
        <div class="muted">Nightly at <b>${esc((a.report.schedule && a.report.schedule.updates) || '?')}</b> · host packages: ${hu.count ?? '—'} waiting${hu.security ? ` (<span class="pct-bad">${hu.security} security</span>)` : ''}</div></div></div>
        ${last ? `<p>${levelTag(last.level)} Last run ${esc(ago(last.t))}: ${esc(last.summary.split('\n')[0])}</p>` : '<p class="muted">No update run yet — the first one is tonight.</p>'}
        <div class="cd-actions"><button class="btn small" data-act="update-all" data-agent="${esc(a.name)}" data-name="${esc(hostOf(a))}">⟳ Run the nightly update now</button>
          <button class="btn small" data-act="check-updates" data-agent="${esc(a.name)}" data-name="${esc(hostOf(a))}">Check host updates</button></div>
        ${actionLog(a.name, null)}
        ${runs.length ? details(`runs:${a.name}`, `Run history (${runs.length})`, `<ul class="events">${runs.slice().reverse().map(u => `<li><time>${esc(fmtDate(u.t))}</time>${levelTag(u.level)}<span><pre class="inline">${esc(u.summary)}</pre></span></li>`).join('')}</ul>`) : ''}
      </div>`;
    }).join('');

    const cs = containers().slice().sort((x, y) => ((y.updates && y.updates.count) || 0) - ((x.updates && x.updates.count) || 0) || x.vmid - y.vmid);
    const rows = cs.map(c => {
      const u = c.updates || {};
      const lu = c.lastUpdate;
      return `<tr><td>${dot(c.status === 'running' ? 'up' : 'down')}<b>${esc(c.name)}</b> <span class="muted">${c.vmid}</span></td><td>${esc(c.host)}</td>
        <td class="num">${u.count ?? '<span class="muted">—</span>'}</td><td class="num">${u.security ? `<span class="pct-bad">${u.security}</span>` : (u.count != null ? '0' : '')}</td>
        <td>${u.checkedAt ? esc(ago(u.checkedAt)) : '<span class="muted">tonight</span>'}</td>
        <td>${lu ? `<span class="${lu.result === 'ok' ? 'pct-good' : lu.result === 'held' ? 'pct-warn' : 'pct-bad'}">${esc(lu.result)}</span> <span class="muted">${esc(ago(lu.t))}</span>` : '<span class="muted">—</span>'}</td>
        <td class="wrap muted">${esc((lu && lu.msg) || '')}${busyNote(c)}</td>
        <td class="row-actions">${c.status === 'running' ? `<button class="btn small" data-act="check" data-agent="${esc(c.agent)}" data-vmid="${c.vmid}" data-name="${esc(c.name)}" title="Refresh the package list and count pending updates">Check</button>
          <button class="btn small primary" data-act="update" data-agent="${esc(c.agent)}" data-vmid="${c.vmid}" data-name="${esc(c.name)}" title="Snapshot, install everything, health-check, roll back if broken">Update now</button>` : ''}</td></tr>`;
    }).join('');
    return `${pageHead('Updates', 'Security updates install every night automatically. Others install when the agent rates them low-risk; the rest wait here. Every update is snapshotted first and rolled back if services break.')}
      <h3 class="sec-title">Waiting for approval</h3><div class="stack">${pendHtml}</div>
      <h3 class="sec-title">Schedule</h3><div class="hosts">${sched}</div>
      <h3 class="sec-title">Containers</h3>
      <div class="card table-card"><div class="table-wrap"><table class="ctable ct-updates">
        <thead><tr><th>Container</th><th>Host</th><th>Pending</th><th>Security</th><th>Checked</th><th>Last update</th><th>Notes</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8" class="muted">No data yet.</td></tr>'}</tbody></table></div></div>`;
  }

  // ------------------------------------------------------------ Backups
  function viewBackups() {
    const cs = containers();
    const covered = cs.filter(c => c.backup && c.backup.covered);
    const fresh = covered.filter(c => backupState(c) === 'ok').length;
    const uncovered = cs.filter(c => !(c.backup && c.backup.covered));
    const tasks = [];
    for (const a of agents()) for (const t of ((a.report && a.report.backups && a.report.backups.tasks) || [])) tasks.push({ ...t, host: hostOf(a) });
    tasks.sort((x, y) => y.t - x.t);
    const failed24 = tasks.filter(t => t.status !== 'OK' && t.status !== 'running' && Date.now() - t.t < 24 * HOUR).length;
    const jobs = new Map();
    for (const a of agents()) for (const j of ((a.report && a.report.backups && a.report.backups.jobs) || [])) {
      const prev = jobs.get(j.id);
      jobs.set(j.id, { ...j, covers: [...new Set([...(prev ? prev.covers : []), ...j.covers])] });
    }
    const bstore = new Map();
    for (const a of agents()) for (const s of ((a.report && a.report.host && a.report.host.storage) || [])) if ([...jobs.values()].some(j => j.storage === s.name)) bstore.set(s.name, s);
    const total = cs.reduce((n, c) => n + ((c.backup && c.backup.size) || 0), 0);

    const kpis = `<div class="kpis">
      ${kpi('Fresh backups', `${fresh}<span class="kpi-of">/${covered.length}</span>`, 'containers backed up in the last 26 h', fresh < covered.length ? 'warn' : '')}
      ${kpi('Not covered', uncovered.length, uncovered.length ? esc(uncovered.map(c => c.name).join(', ')) : 'every container is in a job', uncovered.length ? 'warn' : '')}
      ${kpi('Failed runs (24 h)', failed24, failed24 ? 'see runs below' : 'all good', failed24 ? 'bad' : '')}
      ${kpi('Container backups', bytes(total), 'total size kept (all versions)')}
      ${[...bstore.values()].map(s => kpi(`Storage ${s.name}`, `${Math.round(s.used / s.total * 100)}%`, `${bytes(s.used)} of ${bytes(s.total)}`, s.used / s.total > 0.9 ? 'bad' : s.used / s.total > 0.75 ? 'warn' : '')).join('')}
    </div>`;

    const jobRows = [...jobs.values()].map(j => `<tr><td>${j.enabled ? dot('up') : dot('')}${esc(j.comment || j.id)}</td><td><code>${esc(j.schedule)}</code></td><td>${esc(j.storage)}</td>
      <td>${esc(j.guests)}</td><td>${esc(j.mode || '')}</td><td>${j.keep ? esc(Object.entries(j.keep).map(([k, v]) => `${k.replace('keep-', '')} ${v}`).join(', ')) : ''}</td>
      <td>${j.nextRun ? `${esc(fmtTime(j.nextRun))} <span class="muted">${esc(new Date(j.nextRun).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</span>` : '—'}</td></tr>`).join('');

    const rows = cs.slice().sort((x, y) => (backupAge(y) ?? 9e15) - (backupAge(x) ?? 9e15)).map(c => {
      const b = c.backup || {};
      const age = backupAge(c);
      const snaps = (c.snapshots || []).length;
      return `<tr><td>${dot(c.status === 'running' ? 'up' : 'down')}<b>${esc(c.name)}</b> <span class="muted">${c.vmid}</span></td><td>${esc(c.host)}</td>
        <td>${b.covered ? '<span class="pct-good">yes</span>' : '<span class="pct-bad">no</span>'}</td>
        <td><span class="${ageCls(age)}">${b.last ? esc(ago(b.last.t)) : 'never'}</span></td>
        <td class="num">${b.last && b.last.size ? bytes(b.last.size) : '—'}</td>
        <td>${b.last ? (b.last.verified === 'ok' ? '<span class="pct-good">ok</span>' : `<span class="${b.last.verified === 'failed' ? 'pct-bad' : 'muted'}">${esc(b.last.verified || 'not yet')}</span>`) : ''}</td>
        <td class="num">${b.count || 0}</td><td class="num">${snaps || '<span class="muted">0</span>'}</td></tr>`;
    }).join('');

    const taskRows = tasks.slice(0, 30).map(t => `<li><time>${esc(fmtDate(t.t))}</time>${t.status === 'OK' ? tag('up', 'ok') : t.status === 'running' ? tag('restart', 'running') : tag('down', 'failed')}
      <span><b>${esc(t.host)}</b> ${t.vmid ? `guest ${t.vmid}` : 'backup job'}${t.end ? ` · ${duration((t.end - t.t) / 1000)}` : ''}${t.status !== 'OK' && t.status !== 'running' ? ` — <span class="pct-bad">${esc(t.status)}</span>` : ''}</span></li>`).join('');

    const servers = pbsServers();
    return `${pageHead('Backups', 'Proxmox backup jobs, what each container has on the backup storage, and recent runs. Agent snapshots clean themselves up: update snapshots keep the newest 2, fix snapshots go after 7 days, dashboard snapshots after 30. Snapshots you make in Proxmox are never touched.')}
      ${kpis}
      ${servers.length ? `<div class="hosts">${servers.map(pbsCard).join('')}</div>` : ''}
      <h3 class="sec-title">Containers</h3>
      <div class="card table-card"><div class="table-wrap"><table class="ctable ct-backups">
        <thead><tr><th>Container</th><th>Host</th><th>In a job</th><th>Last backup</th><th>Size</th><th>Verified</th><th>Kept</th><th>Snapshots</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8" class="muted">No data yet.</td></tr>'}</tbody></table></div></div>
      <h3 class="sec-title">Backup jobs</h3>
      <div class="card table-card"><div class="table-wrap"><table class="ctable ct-jobs">
        <thead><tr><th>Job</th><th>Schedule</th><th>Storage</th><th>Guests</th><th>Mode</th><th>Retention</th><th>Next run</th></tr></thead>
        <tbody>${jobRows || '<tr><td colspan="7" class="muted">No backup jobs found.</td></tr>'}</tbody></table></div></div>
      <h3 class="sec-title">Recent runs</h3>
      <div class="card pad">${taskRows ? `<ul class="events">${taskRows}</ul>` : '<p class="muted">No backup runs reported yet.</p>'}</div>`;
  }

  // ------------------------------------------------------------ Uptime: internal services
  function viewServices() {
    const sv = services();
    if (!sv.length) return '';
    const groups = new Map();
    for (const s of sv) {
      const k = `${s.agent}:${s.vmid}`;
      if (!groups.has(k)) groups.set(k, { name: s.container, vmid: s.vmid, agent: s.agent, list: [] });
      groups.get(k).list.push(s);
    }
    const hostName = ag => { const a = agents().find(x => x.name === ag); return a ? hostOf(a) : ag; };
    const cards = [...groups.values()].sort((x, y) => x.name.localeCompare(y.name)).map(g => {
      const down = g.list.filter(s => s.status === 'down').length;
      return `<div class="card svc-card">
        <div class="svc-head">${dot(down ? 'down' : 'up')}<b>${esc(g.name)}</b><span class="muted">${g.vmid} · ${esc(hostName(g.agent))} · ${esc(g.list[0].ip || '')}</span></div>
        ${g.list.sort((x, y) => x.port - y.port).map(s => `<div class="svc-row${s.stale ? ' stale' : ''}">
          <span class="svc-port">${dot(s.stale ? '' : s.status === 'up' ? 'up' : 'down')}${s.port ? `:${s.port}` : 'IP'}</span>
          <span class="svc-proc">${esc(s.proc || '')}</span>
          <span class="svc-bars">${recentBars(s.recent || [], 48)}</span>
          <span class="svc-num">${s.last && s.last.ok && s.last.ms != null ? `${s.last.ms} ms` : s.status === 'down' ? `<span class="pct-bad">down ${esc(ago(s.since).replace(' ago', ''))}</span>` : '—'}</span>
          <span class="svc-num">${pct(s.uptime24h)}</span></div>`).join('')}
      </div>`;
    }).join('');
    const down = sv.filter(s => s.status === 'down' && !s.stale).length;
    return `<div class="section-head"><h3>Internal services <span class="muted">· found automatically, checked on the LAN every 5 min</span></h3>
      <span class="${down ? 'pct-bad' : 'pct-good'}">${down ? `${down} down` : `all ${sv.length} answering`}</span></div>
      <div class="svc-grid">${cards}</div>`;
  }

  // ------------------------------------------------------------ Ask (chats)
  const chatsFor = scope => ((st.data && st.data.chats) || []).filter(c => c.scope === scope);
  function currentChat(scope) {
    const list = chatsFor(scope);
    const sel = st.chatSel[scope];
    if (sel === 'new') return null;
    return list.find(c => c.id === sel) || list[0] || null;
  }
  const pendingText = (a, t) => (t.status === 'queued' ? (a.live ? 'Sending to the agent…' : 'Waiting for the agent to come online…')
    : t.status === 'running' ? `Working on it${t.startedAt ? ` (${duration((Date.now() - t.startedAt) / 1000)})` : ''}… answers usually take 1–3 minutes` : t.status);

  function viewAsk() {
    const ag = agents().filter(a => a.configured);
    if (!ag.length) return empty('No agents configured.');
    if (!st.askAgent || (st.askAgent !== '_all' && !ag.some(a => a.name === st.askAgent))) st.askAgent = '_all';
    const scope = st.askAgent;
    const picker = `<div class="seg big" data-askpick>
      <button class="${scope === '_all' ? 'on' : ''}" data-val="_all">◎ Datacenter <span class="muted">all agents</span></button>
      ${ag.map(x => `<button class="${x.name === scope ? 'on' : ''}" data-val="${esc(x.name)}">${dot(x.online ? 'up' : 'down')}${esc(hostOf(x))} <span class="muted">${esc(x.name)}</span></button>`).join('')}</div>`;
    const chats = chatsFor(scope);
    const chat = currentChat(scope);
    const list = `<aside class="chat-list">
        <button class="btn primary small new-chat" data-newchat>＋ New chat</button>
        ${chats.map(c => `<div class="chat-item${chat && chat.id === c.id ? ' on' : ''}" data-chat="${esc(c.id)}" tabindex="0">
            <div class="ci-title">${esc(c.title)}</div>
            <div class="ci-meta">${esc(ago(c.updatedAt))} · ${c.messages} message${c.messages === 1 ? '' : 's'}</div>
            <button class="ci-del" data-delchat="${esc(c.id)}" title="Delete this chat" aria-label="Delete chat">×</button>
          </div>`).join('') || '<p class="muted small-note">No chats yet. Write below to start one.</p>'}
      </aside>`;
    const msgs = chat ? (scope === '_all' ? groupMessages(ag, chat.id) : agentMessages(ag.find(x => x.name === scope), chat.id)) : '';
    const target = scope === '_all' ? ag : [ag.find(x => x.name === scope)];
    const offline = target.filter(a => !a.online).map(a => hostOf(a));
    const draftKey = `${scope}:${chat ? chat.id : 'new'}`;
    const main = `<section class="chat-main card">
        <div class="chat-head">
          <div><h3>${chat ? esc(chat.title) : 'New chat'}</h3>
            <div class="muted">${scope === '_all' ? `Every agent answers for its own host (${target.map(a => esc(hostOf(a))).join(', ')})` : `${esc(scope)} on ${esc(hostOf(target[0]))}`}${chat ? ' · follow-ups remember this conversation' : ''}</div></div>
          ${chat ? `<button class="btn small ghost" data-renamechat="${esc(chat.id)}">✎ Rename</button>` : ''}
        </div>
        <div class="convo">${msgs || `<p class="muted center">${chat ? 'No messages left in this chat.' : 'Ask a question or tell the agent what to fix.'}</p>`}</div>
        <form class="ask-form" data-agent="${esc(scope)}" data-chat="${chat ? esc(chat.id) : ''}" data-draft="${esc(draftKey)}">
          <textarea name="text" rows="3" maxlength="4000" placeholder="${scope === '_all' ? 'e.g. Which containers use the most disk? · Are any services failing? · Check every container for pending reboots' : 'e.g. Why is AMPServer2 using so much memory? · Pi-hole isn\'t answering DNS, fix it · Update ai now'}">${esc(st.drafts[draftKey] || '')}</textarea>
          <div class="ask-actions"><span class="muted">${chat ? 'Reply in this chat' : 'Starts a new chat'}${offline.length ? ` — <span class="pct-bad">${esc(offline.join(', '))} offline, runs when back</span>` : ''} · Ctrl+Enter to send</span>
            <button class="btn primary" type="submit">${scope === '_all' ? 'Send to all' : 'Send'}</button></div>
        </form>
      </section>`;
    const auto = scope !== '_all' ? (((target[0].report && target[0].report.autoTasks) || []).slice().reverse()) : [];
    return `${pageHead('Ask agents', 'Each agent can look at and fix the containers on its own host; host changes only when you ask explicitly. <b>Datacenter</b> asks every agent at once. If an agent can\'t fix something it gives you a plan to paste into Claude Code.')}
      ${picker}
      <div class="chat-shell">${list}${main}</div>
      ${usagePanel(target)}
      ${auto.length ? details(`auto:${scope}`, `Automatic fixes the agent started itself (${auto.length})`, auto.map(t => `<div class="msg"><div class="q"><div class="q-meta">${esc(ago(t.t))} ${statusTag(t.status)}</div><div class="q-text">${esc(t.text)}</div></div>${t.output ? `<div class="ans">${md(t.output)}</div>` : ''}</div>`).join(''), 'card pad') : ''}`;
  }

  function agentMessages(a, chatId) {
    const tasks = (a.tasks || []).filter(t => t.chat === chatId && !t.action).sort((x, y) => x.createdAt - y.createdAt);
    return tasks.map(t => `<div class="msg">
      <div class="q"><div class="q-meta">${esc(t.by || '')} · ${esc(ago(t.createdAt))} ${statusTag(t.status)}
        <button class="msg-del" data-delmsg="${esc(t.id)}" data-agent="${esc(a.name)}" title="Delete this message">🗑</button></div>
        <div class="q-text">${esc(t.text)}</div></div>
      ${t.output ? `<div class="ans"><div class="ans-meta">✦ ${esc(a.name)}${t.finishedAt ? ` · ${esc(ago(t.finishedAt))}` : ''} ${usageLine(t.usage)}</div>${(rememberPlan({ ...t, agentName: a.name }), answer(t.output, t.id))}</div>`
        : `<div class="ans pending">${esc(pendingText(a, t))}</div>`}
    </div>`).join('');
  }

  function groupMessages(ag, chatId) {
    const groups = new Map();
    for (const a of ag) for (const t of (a.tasks || [])) {
      if (t.chat !== chatId || !t.group) continue;
      if (!groups.has(t.group)) groups.set(t.group, { id: t.group, text: t.text, by: t.by, t: t.createdAt, parts: [] });
      groups.get(t.group).parts.push({ a, t });
    }
    return [...groups.values()].sort((x, y) => x.t - y.t).map(g => {
      const states = g.parts.map(p => p.t.status);
      const overall = states.every(x => x === 'done') ? 'done' : states.some(x => x === 'failed') ? 'failed' : states.some(x => x === 'running') ? 'running' : states.every(x => x === 'cancelled') ? 'cancelled' : 'queued';
      return `<div class="msg">
        <div class="q"><div class="q-meta">◎ all hosts · ${esc(g.by || '')} · ${esc(ago(g.t))} ${statusTag(overall)}
          <button class="msg-del" data-delgroup="${esc(g.id)}" title="Delete this message and its answers">🗑</button></div>
          <div class="q-text">${esc(g.text)}</div></div>
        ${g.parts.sort((x, y) => hostOf(x.a).localeCompare(hostOf(y.a))).map(({ a, t }) => t.output
          ? `<div class="ans"><div class="ans-meta">✦ ${esc(hostOf(a))} · ${esc(a.name)}${t.finishedAt ? ` · ${esc(ago(t.finishedAt))}` : ''} ${statusTag(t.status)} ${usageLine(t.usage)}</div>${(rememberPlan({ ...t, agentName: a.name }), answer(t.output, t.id))}</div>`
          : `<div class="ans pending">✦ ${esc(hostOf(a))}: ${esc(pendingText(a, t))}</div>`).join('')}
      </div>`;
    }).join('');
  }

  const statusTag = s => tag(s === 'done' ? 'up' : s === 'failed' ? 'down' : s === 'cancelled' ? '' : 'restart', s);

  // How much Claude the agents used (from each run's own token report).
  function usagePanel(list) {
    const sum = key => {
      const o = { runs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      for (const a of list) { const u = a.report && a.report.usage && a.report.usage[key]; if (u) for (const k in o) o[k] += u[k] || 0; }
      return o;
    };
    const today = sum('today'), week = sum('week'), month = sum('month');
    const days = new Map();
    for (const a of list) for (const [d, v] of Object.entries((a.report && a.report.usage && a.report.usage.daily) || {})) {
      const cur = days.get(d) || { tokens: 0, cost: 0, runs: 0 };
      cur.tokens += usageTotal(v); cur.cost += v.cost || 0; cur.runs += v.runs || 0;
      days.set(d, cur);
    }
    const keys = [];
    for (let i = 29; i >= 0; i--) keys.push(new Date(Date.now() - i * 86400e3).toLocaleDateString('en-CA'));
    const max = Math.max(1, ...keys.map(k => (days.get(k) || {}).tokens || 0));
    const bars = keys.map(k => { const v = days.get(k) || { tokens: 0, cost: 0, runs: 0 }; return `<span style="height:${Math.max(2, (v.tokens / max) * 100)}%" class="${v.tokens ? '' : 'none'}" title="${esc(`${k}: ${kTok(v.tokens)} tokens · ${v.runs} run(s) · $${v.cost.toFixed(2)}`)}"></span>`; }).join('');
    const recent = [];
    for (const a of list) for (const r of ((a.report && a.report.usage && a.report.usage.recent) || [])) recent.push({ ...r, agent: a.name });
    recent.sort((x, y) => y.t - x.t);
    const tile = (label, u) => `<div class="kpi"><div class="kpi-k">${label}</div><div class="kpi-v">${kTok(usageTotal(u))}</div><div class="kpi-s">${u.runs} run${u.runs === 1 ? '' : 's'} · ≈ $${u.cost.toFixed(2)} at API prices</div></div>`;
    return `<h3 class="sec-title">Claude usage by ${list.length > 1 ? 'the agents' : esc(list[0] ? list[0].name : 'agent')}</h3>
      <div class="kpis">${tile('Today', today)}${tile('Last 7 days', week)}${tile('Last 30 days', month)}</div>
      <div class="card pad"><div class="usage-bars">${bars}</div><div class="bars-legend"><span>30 days ago</span><span>Today</span></div>
        <p class="hint">Tokens the agents used: answers, auto-fixes and nightly update reviews. This counts against your Claude plan's limits; your plan's overall usage is on claude.ai → Settings → Usage.</p>
        ${recent.length ? details(`usage:${list.map(a => a.name).join(',')}`, `Recent runs (${recent.length})`, `<table class="mini"><tbody>${recent.slice(0, 25).map(r => `<tr><td class="muted">${esc(ago(r.t))}</td><td>${esc(r.agent)}</td><td>${tag(r.kind === 'review' ? '' : r.kind === 'autofix' ? 'restart' : 'up', r.kind || 'task')}</td><td class="wrap">${esc(r.label || '')}</td><td class="num">${kTok(usageTotal(r))}</td><td class="num">$${Number(r.cost || 0).toFixed(2)}</td></tr>`).join('')}</tbody></table>`) : ''}
      </div>`;
  }

  // ------------------------------------------------------------ Activity
  function viewActivity() {
    const f = st.filters;
    const items = [];
    for (const a of agents()) {
      const r = a.report || {};
      for (const e of (r.events || [])) items.push({ t: e.t, level: e.level, host: hostOf(a), msg: e.msg });
      for (const u of (r.updateRuns || [])) items.push({ t: u.t, level: u.level, host: hostOf(a), msg: `Update run: ${u.summary}` });
    }
    let list = items.sort((x, y) => y.t - x.t);
    if (f.ahost) list = list.filter(i => i.host === f.ahost);
    if (f.level) list = list.filter(i => (f.level === 'problems' ? i.level !== 'info' : true));
    const li = list.slice(0, 300).map(i => `<li><time>${esc(fmtDate(i.t))}</time>${levelTag(i.level)}<span><b>${esc(i.host)}</b> <span class="pre-line">${esc(i.msg)}</span></span></li>`).join('');
    return `${pageHead('Activity', 'Everything the agents did or noticed: restarts, updates, rollbacks, approvals, backup failures.')}
      <div class="toolbar">${hostFilter('ahost')}
        <div class="seg" data-filter="level">${[['', 'Everything'], ['problems', 'Warnings & errors']].map(([v, l]) => `<button class="${f.level === v ? 'on' : ''}" data-val="${v}">${l}</button>`).join('')}</div></div>
      <div class="card pad">${li ? `<ul class="events">${li}</ul>` : '<p class="muted">Nothing yet.</p>'}</div>`;
  }

  // ------------------------------------------------------------ navigation & render
  function currentView(d) {
    const v = (location.hash || '').replace(/^#\/?/, '');
    if (!enabled(d)) return 'uptime';
    return VIEWS.includes(v) ? v : 'overview';
  }

  function badges(d) {
    if (!enabled(d)) return;
    const att = attention(d);
    const set = (k, n, cls = '') => { const el = $(`[data-badge="${k}"]`); if (el) { el.textContent = n ? String(n) : ''; el.className = `nb ${n ? cls : ''}`; } };
    set('overview', att.filter(i => i.level === 'err').length, 'bad');
    set('containers', containers().filter(c => c.onboot && c.status !== 'running').length, 'bad');
    set('updates', agents().reduce((n, a) => n + ((a.report && a.report.pending) || []).filter(p => !a.decisions[p.id]).length, 0), 'warn');
    set('backups', att.filter(i => i.view === 'backups').length, 'warn');
    set('uptime', ((d.monitors || []).filter(m => m.status === 'down').length) + services().filter(s => s.status === 'down' && !s.stale).length, 'bad');
    set('ask', agents().reduce((n, a) => n + (a.tasks || []).filter(t => t.status === 'queued' || t.status === 'running').length, 0), '');
    const errs = att.filter(i => i.level === 'err').length;
    const hs = $('#headStatus');
    hs.hidden = false;
    hs.className = `head-status ${errs ? 'bad' : att.length ? 'warn' : 'ok'}`;
    hs.textContent = errs ? `${errs} problem${errs > 1 ? 's' : ''}` : att.length ? `${att.length} to check` : 'all good';
    document.title = `${errs ? `(${errs}) ` : ''}${d.title}`;
  }

  function render(d) {
    const on = enabled(d);
    const view = currentView(d);
    $('#sidenav').hidden = !on;
    document.body.classList.toggle('with-nav', on);
    if (d && d.locked) { $$('.view').forEach(v => { v.hidden = true; }); return; }
    $$('.view').forEach(v => { v.hidden = v.dataset.view !== view; });
    $$('#sidenav a').forEach(a => a.classList.toggle('active', a.dataset.view === view));
    if (!on) { $('#v-services').innerHTML = ''; return; }
    if (!st.data) {
      if (st.error) { const el = $(`#v-${view}`); if (el) morph(el, empty(st.error)); }
      if (!st.loading) { st.loading = true; load(d).then(() => { st.loading = false; if (st.data) render(d); }); }
      return;
    }
    badges(d);
    const target = view === 'uptime' ? $('#v-services') : $(`#v-${view}`);
    if (selectingIn(target)) return;
    const fn = { overview: viewOverview, containers: viewContainers, updates: viewUpdates, backups: viewBackups, ask: viewAsk, activity: viewActivity, uptime: viewServices }[view];
    morph(target, fn(d));
  }

  const rerender = () => state.data && render(state.data);

  // ------------------------------------------------------------ events
  window.addEventListener('hashchange', () => { rerender(); window.scrollTo(0, 0); });

  document.addEventListener('toggle', e => {
    const el = e.target;
    if (!(el instanceof HTMLDetailsElement) || !el.dataset.key) return;
    if (el.open) st.open.add(el.dataset.key); else st.open.delete(el.dataset.key);
  }, true);

  document.addEventListener('change', e => {
    const cb = e.target.closest && e.target.closest('input[data-pkg]');
    if (!cb) return;
    const key = cb.closest('[data-sel]').dataset.sel;
    const set = st.sel.get(key) || new Set();
    if (cb.checked) set.add(cb.dataset.pkg); else set.delete(cb.dataset.pkg);
    st.sel.set(key, set);
    rerender();
  });

  document.addEventListener('input', e => {
    const t = e.target;
    if (t.matches && t.matches('[data-filter-input]')) { st.filters[t.dataset.filterInput] = t.value; morph($('#v-containers'), viewContainers()); return; }
    const form = t.closest && t.closest('.ask-form');
    if (form) { st.drafts[form.dataset.draft || form.dataset.agent] = t.value; if (t.value) t.dataset.dirty = '1'; else delete t.dataset.dirty; }
  });

  document.addEventListener('click', async e => {
    const seg = e.target.closest('.seg button');
    if (seg) {
      const wrap = seg.closest('.seg');
      if (wrap.dataset.filter !== undefined) st.filters[wrap.dataset.filter] = seg.dataset.val;
      if (wrap.hasAttribute('data-askpick')) st.askAgent = seg.dataset.val;
      rerender();
      return;
    }
    const row = e.target.closest('tr.crow');
    if (row) { const id = row.dataset.ct; if (st.expanded.has(id)) st.expanded.delete(id); else st.expanded.add(id); rerender(); return; }
    const ask = e.target.closest('[data-ask]');
    if (ask) { st.askAgent = ask.dataset.ask; st.drafts[ask.dataset.ask] = ask.dataset.prefill; location.hash = '#ask'; setTimeout(() => { const ta = $('.ask-form textarea'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }, 50); return; }
    const chatBtn = e.target.closest('[data-newchat], [data-delchat], [data-renamechat], [data-delmsg], [data-delgroup], .chat-item');
    if (chatBtn) {
      const scope = st.askAgent;
      try {
        if (chatBtn.hasAttribute('data-newchat')) { st.chatSel[scope] = 'new'; rerender(); setTimeout(() => { const ta = $('.ask-form textarea'); if (ta) ta.focus(); }, 30); return; }
        if (chatBtn.dataset.delchat) {
          const c = chatsFor(scope).find(x => x.id === chatBtn.dataset.delchat);
          if (!confirm(`Delete the chat "${c ? c.title : ''}" and all of its messages? This can't be undone.`)) return;
          await api(`api/infra/chats/${encodeURIComponent(chatBtn.dataset.delchat)}`, { method: 'DELETE' });
          if (st.chatSel[scope] === chatBtn.dataset.delchat) delete st.chatSel[scope];
          toast('Chat deleted');
        } else if (chatBtn.dataset.renamechat) {
          const c = chatsFor(scope).find(x => x.id === chatBtn.dataset.renamechat);
          const title = prompt('Rename chat', c ? c.title : '');
          if (!title || !title.trim()) return;
          await api(`api/infra/chats/${encodeURIComponent(chatBtn.dataset.renamechat)}/rename`, { method: 'POST', body: { title } });
        } else if (chatBtn.dataset.delmsg) {
          if (!confirm('Delete this message and its answer?')) return;
          await api(`api/infra/${encodeURIComponent(chatBtn.dataset.agent)}/tasks/${chatBtn.dataset.delmsg}`, { method: 'DELETE' });
        } else if (chatBtn.dataset.delgroup) {
          if (!confirm('Delete this message and every agent\'s answer to it?')) return;
          await api(`api/infra/_all/groups/${chatBtn.dataset.delgroup}`, { method: 'DELETE' });
        } else if (chatBtn.classList.contains('chat-item')) {
          st.chatSel[scope] = chatBtn.dataset.chat; rerender(); return;
        }
        await load(state.data); rerender();
      } catch (err) { toast(err.message, true); }
      return;
    }
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const key = pick.closest('[data-sel]').dataset.sel;
      const [agent, ...rest] = key.split(':');
      const id = rest.join(':');
      const a = agents().find(x => x.name === agent);
      const p = ((a && a.report && a.report.pending) || []).find(x => x.id === id);
      const pk = (p && p.packages) || [];
      st.sel.set(key, new Set(pick.dataset.pick === 'all' ? pk.map(x => x.name) : pick.dataset.pick === 'security' ? pk.filter(x => x.security).map(x => x.name) : []));
      rerender();
      return;
    }
    const cp = e.target.closest('[data-copy-plan]');
    if (cp) {
      const text = plans.get(cp.dataset.copyPlan) || '';
      try { await navigator.clipboard.writeText(text); }
      catch {
        const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      toast('Plan copied. Paste it into Claude Code.');
      return;
    }
    const act = e.target.closest('[data-act]');
    if (act) {
      const { agent, vmid, name } = act.dataset;
      const type = act.dataset.act;
      const ask = {
        start: `Start ${name}?`, shutdown: `Shut down ${name}? Its services stop until you start it again.`,
        reboot: `Reboot ${name}? Its services are briefly unavailable.`, snapshot: `Take a snapshot of ${name}?`,
        backup: `Back up ${name} now to the backup storage?`,
        check: `Check ${name} for updates now? (Refreshes its package list; nothing is installed.)`,
        update: `Install all pending updates on ${name} now? A snapshot is taken first and it rolls back automatically if services break.`,
        'update-all': `Run the full nightly update on ${name} now? Every container is snapshotted, updated and checked one by one.`,
        'check-updates': `Check ${name} for host package updates now?`,
      }[type];
      if (!confirm(ask)) return;
      act.disabled = true;
      try {
        await api(`api/infra/${encodeURIComponent(agent)}/actions`, { method: 'POST', body: { type, vmid: vmid ? Number(vmid) : null } });
        toast('Sent. Progress shows here.');
        await load(state.data); rerender();
      } catch (err) { toast(err.message, true); act.disabled = false; }
      return;
    }
    const dec = e.target.closest('[data-decide]');
    const cancel = e.target.closest('[data-cancel]');
    try {
      if (dec) {
        const { agent, id } = dec.dataset;
        const selNow = st.sel.get(`${agent}:${id}`);
        const what = dec.closest('.approval').querySelector('b').textContent + (dec.dataset.decide === 'approve' && selNow ? ` (${selNow.size} package${selNow.size === 1 ? '' : 's'})` : '');
        if (!confirm(`${dec.dataset.decide === 'approve' ? 'Approve' : 'Deny'}: ${what}?`)) return;
        dec.disabled = true;
        const sel = st.sel.get(`${agent}:${id}`);
        const body = { id, decision: dec.dataset.decide };
        if (dec.dataset.decide === 'approve' && sel) body.packages = [...sel];
        await api(`api/infra/${encodeURIComponent(agent)}/decision`, { method: 'POST', body });
        toast(dec.dataset.decide === 'approve' ? `Approved. ${agent} is starting on it.` : 'Denied.');
      } else if (cancel) {
        await api(`api/infra/${encodeURIComponent(cancel.dataset.agent)}/tasks/${cancel.dataset.cancel}/cancel`, { method: 'POST', body: {} });
        toast('Cancelled');
      } else return;
      await load(state.data); rerender();
    } catch (err) { toast(err.message, true); }
  });

  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('tr.crow')) { e.preventDefault(); e.target.click(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.closest && e.target.closest('.ask-form')) { e.preventDefault(); e.target.closest('form').requestSubmit(); }
  });

  document.addEventListener('submit', async e => {
    const form = e.target.closest('.ask-form');
    if (!form) return;
    e.preventDefault();
    const agent = form.dataset.agent;
    const text = form.text.value.trim();
    if (!text) return;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const r = await api(`api/infra/${encodeURIComponent(agent)}/tasks`, { method: 'POST', body: { text, ...(form.dataset.chat ? { chat: form.dataset.chat } : {}) } });
      const chatId = agent === '_all' ? (r.tasks && r.tasks[0] && r.tasks[0].chat) : r.chat;
      if (chatId) st.chatSel[agent] = chatId;
      st.drafts[form.dataset.draft] = '';
      st.drafts[agent] = '';
      form.text.value = '';
      delete form.text.dataset.dirty;
      form.text.blur();
      toast(agent === '_all' ? 'Sent to every agent.' : `Sent to ${agent}.`);
      await load(state.data); rerender();
    } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
  });

  return { load, render };
})();

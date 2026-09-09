import { FormEvent, useMemo, useState } from 'react';
import type { SessionSnapshot } from '../shared/types.js';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as T;
}

export function App() {
  const [session, setSession] = useState<SessionSnapshot>();
  const [projectName, setProjectName] = useState('');
  const [summary, setSummary] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const progress = useMemo(() => session ? Math.min(100, Math.round(((session.phaseIndex + 1) / session.phaseCount) * 100)) : 0, [session]);

  async function start(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const data = await api<SessionSnapshot>('/api/sessions', { method: 'POST', body: JSON.stringify({ projectName, summary }) });
      setSession(data);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!session || !message.trim()) return;
    const current = message; setMessage(''); setBusy(true); setError('');
    try {
      const data = await api<SessionSnapshot>(`/api/sessions/${session.sessionId}/messages`, { method: 'POST', body: JSON.stringify({ message: current }) });
      setSession(data);
    } catch (e) { setMessage(current); setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function finalize() {
    if (!session) return; setBusy(true); setError('');
    try { setSession(await api<SessionSnapshot>(`/api/sessions/${session.sessionId}/finalize`, { method: 'POST', body: '{}' })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (!session) {
    return <main className="landing">
      <section className="hero">
        <div className="eyebrow">ALLASCODE · SEMANTIC AS CODE</div>
        <h1>Forge the system before writing it.</h1>
        <p>Descreva o sistema em uma entrevista. O agente extrai Intents, Entities, AtomicAction Behaviors, invariantes, fluxos e políticas e materializa o Blueprint via MCP.</p>
        <form onSubmit={start} className="start-card">
          <label>Nome do projeto<input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="MyCommerce" autoFocus /></label>
          <label>Resumo inicial<textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Um sistema que..." rows={4} /></label>
          <button disabled={busy || !projectName.trim()}>{busy ? 'Criando…' : 'Iniciar entrevista'}</button>
          {error && <div className="error">{error}</div>}
        </form>
      </section>
    </main>;
  }

  return <main className="shell">
    <aside className="sidebar">
      <div><div className="eyebrow">SEMANTIC AS CODE FORGER</div><h2>{session.projectName}</h2><p>{session.summary}</p></div>
      <div className="phase"><span>Fase atual</span><strong>{session.phaseName}</strong><div className="bar"><i style={{ width: `${progress}%` }} /></div><small>{progress}% da entrevista</small></div>
      <div className="artifacts"><span>Blueprint vivo</span><strong>{session.artifacts.length} artefatos</strong><strong>{session.tree.length} arquivos</strong></div>
      <div className="side-actions">
        <button className="secondary" onClick={finalize} disabled={busy || Boolean(session.finalizedAt)}>Finalizar Blueprint</button>
        <a className="secondary link" href={`/api/sessions/${session.sessionId}/export`}>Baixar .zip</a>
      </div>
    </aside>

    <section className="chat-panel">
      <header><div><b>Entrevistador semântico</b><span>{session.finalizedAt ? 'Blueprint finalizado' : 'MCP materializer conectado'}</span></div></header>
      <div className="messages">
        {session.turns.filter((turn) => !turn.content.startsWith('[project initialized:')).map((turn, index) =>
          <article key={`${turn.at}-${index}`} className={`message ${turn.role}`}><div className="role">{turn.role === 'assistant' ? 'FORGER' : 'VOCÊ'}</div><p>{turn.content}</p></article>
        )}
      </div>
      <form className="composer" onSubmit={send}>
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Descreva em linguagem natural…" rows={3} disabled={busy || Boolean(session.finalizedAt)} />
        <button disabled={busy || !message.trim() || Boolean(session.finalizedAt)}>{busy ? 'Analisando…' : 'Enviar'}</button>
      </form>
      {error && <div className="error inline">{error}</div>}
    </section>

    <aside className="inspector">
      <section><div className="section-title">ARTEFATOS</div>{session.artifacts.slice().reverse().slice(0, 20).map((a) => <div className="artifact" key={`${a.kind}-${a.canonicalLabel}`}><small>{a.kind}</small><b>{a.canonicalLabel}</b><p>{a.summary}</p></div>)}{session.artifacts.length === 0 && <p className="muted">Aparecem conforme a semântica fica explícita.</p>}</section>
      <section><div className="section-title">VALIDAÇÃO</div>{session.validation.map((v, i) => <div className={`finding ${v.severity}`} key={`${v.code}-${i}`}><b>{v.code}</b><span>{v.message}</span></div>)}{session.validation.length === 0 && <p className="muted">Sem achados.</p>}</section>
      <section><div className="section-title">TREE</div><pre className="tree">{session.tree.slice(0, 60).join('\n')}</pre></section>
    </aside>
  </main>;
}

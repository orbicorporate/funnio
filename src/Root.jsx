import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient.js";
import FunnioApp from "./FunnioApp.jsx";
import { LogOut, Users, ArrowLeftRight, Copy, Check } from "lucide-react";

function installStorageBridge(workspaceId) {
  window.storage = {
    async get(key) {
      const { data, error } = await supabase.rpc("crm_get_blob", { ws_id: workspaceId, blob_key: key });
      if (error || data === null || data === undefined) return null;
      return { key, value: JSON.stringify(data), shared: true };
    },
    async set(key, value) {
      let parsed;
      try { parsed = JSON.parse(value); } catch { parsed = value; }
      const { error } = await supabase.rpc("crm_set_blob", { ws_id: workspaceId, blob_key: key, blob_value: parsed });
      if (error) return null;
      return { key, value, shared: true };
    },
    async delete(key) {
      const { error } = await supabase.rpc("crm_set_blob", { ws_id: workspaceId, blob_key: key, blob_value: null });
      if (error) return null;
      return { key, deleted: true, shared: true };
    },
    async list() {
      return { keys: [], shared: true };
    },
  };
}

export default function Root() {
  const [session, setSession] = useState(undefined);
  const [workspaces, setWorkspaces] = useState([]);
  const [activeWorkspace, setActiveWorkspace] = useState(null);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [authError, setAuthError] = useState("");
  const [busy, setBusy] = useState(false);
  const [wsError, setWsError] = useState("");
  const [tab, setTab] = useState("create");
  const [showMenu, setShowMenu] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (!newSession) { setWorkspaces([]); setActiveWorkspace(null); setBridgeReady(false); }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const loadWorkspaces = useCallback(async () => {
    const { data, error } = await supabase.rpc("crm_my_workspaces");
    if (!error) setWorkspaces(data || []);
    return error ? [] : data || [];
  }, []);

  useEffect(() => {
    if (session) loadWorkspaces();
  }, [session, loadWorkspaces]);

  useEffect(() => {
    if (activeWorkspace) {
      installStorageBridge(activeWorkspace.id);
      localStorage.setItem("funnio_active_ws", activeWorkspace.id);
      setBridgeReady(true);
    } else {
      setBridgeReady(false);
    }
  }, [activeWorkspace]);

  useEffect(() => {
    if (session && workspaces.length > 0 && !activeWorkspace) {
      const savedId = localStorage.getItem("funnio_active_ws");
      const found = workspaces.find((w) => w.id === savedId);
      if (found) setActiveWorkspace(found);
    }
  }, [session, workspaces, activeWorkspace]);

  const translateAuthError = (msg) => {
    if (/invalid login credentials/i.test(msg)) return "Email ou senha incorretos.";
    if (/already registered/i.test(msg)) return "Já existe uma conta com esse email.";
    if (/password.*6/i.test(msg)) return "A senha precisa ter pelo menos 6 caracteres.";
    return msg;
  };

  const handleAuthSubmit = async (email, password) => {
    if (!email || !password) { setAuthError("Preencha email e senha."); return; }
    setAuthError(""); setBusy(true);
    const { error } = authMode === "login"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (error) { setAuthError(translateAuthError(error.message)); return; }
    if (authMode === "signup") {
      setAuthMode("login");
      setAuthError("Conta criada! Se pedir confirmação por email, confira sua caixa de entrada e depois entre.");
    }
  };

  const handleCreateWorkspace = async (name) => {
    if (!name.trim()) return;
    setBusy(true); setWsError("");
    const displayName = (session.user.email || "").split("@")[0];
    const { data, error } = await supabase.rpc("crm_create_workspace", { ws_name: name.trim(), owner_display_name: displayName });
    setBusy(false);
    if (error) { setWsError(error.message); return; }
    const list = await loadWorkspaces();
    const found = list.find((w) => w.id === data);
    if (found) setActiveWorkspace(found);
  };

  const handleJoinWorkspace = async (displayName, code) => {
    if (!displayName.trim() || !code.trim()) { setWsError("Preencha seu nome e o código."); return; }
    setBusy(true); setWsError("");
    const { data, error } = await supabase.rpc("crm_join_workspace", { invite_code: code.trim(), display_name: displayName.trim() });
    setBusy(false);
    if (error) {
      const msg = /inválido/i.test(error.message) ? "Código de convite inválido."
        : /expirou/i.test(error.message) ? "Este convite expirou. Peça um novo."
        : /limite/i.test(error.message) ? "Este convite já foi usado o máximo de vezes permitido."
        : error.message;
      setWsError(msg);
      return;
    }
    const list = await loadWorkspaces();
    const found = list.find((w) => w.id === data);
    if (found) setActiveWorkspace(found);
  };

  const handleCreateInvite = async () => {
    setInviteCode("...");
    const { data, error } = await supabase.rpc("crm_create_invite", { ws_id: activeWorkspace.id, expires_hours: 168, uses: null });
    setInviteCode(error ? "" : data);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    localStorage.removeItem("funnio_active_ws");
    setActiveWorkspace(null);
  };

  if (session === undefined) {
    return <CenteredMessage>Carregando...</CenteredMessage>;
  }

  if (!session) {
    return (
      <AuthScreen
        mode={authMode}
        setMode={(m) => { setAuthMode(m); setAuthError(""); }}
        onSubmit={handleAuthSubmit}
        error={authError}
        busy={busy}
      />
    );
  }

  if (!activeWorkspace || !bridgeReady) {
    return (
      <WorkspacePicker
        email={session.user.email}
        workspaces={workspaces}
        onOpen={setActiveWorkspace}
        onCreate={handleCreateWorkspace}
        onJoin={handleJoinWorkspace}
        onLogout={handleLogout}
        error={wsError}
        busy={busy}
        tab={tab}
        setTab={setTab}
      />
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <FunnioApp key={activeWorkspace.id} />
      <WorkspaceMenu
        workspaceName={activeWorkspace.name}
        show={showMenu}
        setShow={setShowMenu}
        onSwitch={() => { setActiveWorkspace(null); setShowMenu(false); }}
        onLogout={handleLogout}
        onInvite={handleCreateInvite}
        inviteCode={inviteCode}
        clearInvite={() => setInviteCode("")}
        copied={copied}
        setCopied={setCopied}
      />
    </div>
  );
}

function CenteredMessage({ children }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0a0a", color: "#9a9aa3", fontFamily: "Arial, sans-serif", fontSize: 14 }}>
      {children}
    </div>
  );
}

function AuthScreen({ mode, setMode, onSubmit, error, busy }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const isLogin = mode === "login";
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg, #0a0a0a, #14140f)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: '"Open Sans", Arial, sans-serif' }}>
      <div style={{ width: "100%", maxWidth: 360 }}>
        <div style={{ width: 64, height: 64, borderRadius: 18, background: "linear-gradient(135deg, #84cc16, #a3e635)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", filter: "drop-shadow(0 8px 20px rgba(163,230,53,0.35))" }}>
          <span style={{ fontSize: 28, fontWeight: 900, color: "#0f1a03" }}>F</span>
        </div>
        <h1 style={{ textAlign: "center", color: "white", fontSize: 24, fontWeight: 800, margin: "0 0 4px" }}>Funnio</h1>
        <div style={{ textAlign: "center", color: "#9a9aa3", fontSize: 13, marginBottom: 24 }}>{isLogin ? "Entre na sua conta" : "Crie sua conta"}</div>
        <div style={{ background: "#161611", border: "1px solid #26261f", borderRadius: 20, padding: 22 }}>
          {error && <div style={{ background: "rgba(226,72,63,0.1)", border: "1px solid rgba(226,72,63,0.3)", color: "#f87171", padding: "10px 14px", borderRadius: 10, fontSize: 12.5, marginBottom: 14 }}>{error}</div>}
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="seu@email.com" style={inputStyle} />
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Senha (mín. 6 caracteres)" style={{ ...inputStyle, marginBottom: 16 }} onKeyDown={(e) => e.key === "Enter" && onSubmit(email, password)} />
          <button disabled={busy} onClick={() => onSubmit(email, password)} style={primaryBtnStyle}>{busy ? "..." : isLogin ? "Entrar" : "Criar conta"}</button>
          <button onClick={() => setMode(isLogin ? "signup" : "login")} style={linkBtnStyle}>{isLogin ? "Não tem conta? Criar uma" : "Já tem conta? Entrar"}</button>
        </div>
      </div>
    </div>
  );
}

function WorkspacePicker({ email, workspaces, onOpen, onCreate, onJoin, onLogout, error, busy, tab, setTab }) {
  const [wsName, setWsName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [code, setCode] = useState("");
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg, #0a0a0a, #14140f)", padding: "40px 20px", fontFamily: '"Open Sans", Arial, sans-serif' }}>
      <div style={{ maxWidth: 420, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
          <div>
            <h1 style={{ color: "white", fontSize: 20, fontWeight: 800, margin: 0 }}>Seu funil</h1>
            <div style={{ color: "#9a9aa3", fontSize: 12.5 }}>{email}</div>
          </div>
          <button onClick={onLogout} style={{ background: "transparent", border: "none", color: "#a3e635", fontSize: 12.5, cursor: "pointer" }}>Sair</button>
        </div>

        {workspaces.length > 0 && (
          <div style={{ background: "#161611", border: "1px solid #26261f", borderRadius: 18, padding: 16, marginBottom: 16 }}>
            <div style={{ color: "#9a9aa3", fontSize: 12, fontWeight: 700, marginBottom: 10 }}>SEUS FUNIS</div>
            {workspaces.map((w) => (
              <div key={w.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#1e1e17", borderRadius: 12, padding: "10px 12px", marginBottom: 8 }}>
                <div>
                  <div style={{ color: "white", fontWeight: 700, fontSize: 13.5 }}>{w.name}</div>
                  <div style={{ color: "#767670", fontSize: 11 }}>{w.member_count} pessoa{w.member_count === 1 ? "" : "s"} · {w.role === "owner" ? "dono" : "membro"}</div>
                </div>
                <button onClick={() => onOpen(w)} style={{ background: "#a3e635", color: "#0f1a03", border: "none", borderRadius: 9, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Entrar</button>
              </div>
            ))}
          </div>
        )}

        <div style={{ background: "#161611", border: "1px solid #26261f", borderRadius: 18, padding: 18 }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
            <div onClick={() => setTab("create")} style={{ flex: 1, textAlign: "center", padding: 8, borderRadius: 10, fontSize: 12.5, fontWeight: 700, cursor: "pointer", background: tab === "create" ? "#26261f" : "transparent", color: tab === "create" ? "#a3e635" : "#767670" }}>Criar novo funil</div>
            <div onClick={() => setTab("join")} style={{ flex: 1, textAlign: "center", padding: 8, borderRadius: 10, fontSize: 12.5, fontWeight: 700, cursor: "pointer", background: tab === "join" ? "#26261f" : "transparent", color: tab === "join" ? "#a3e635" : "#767670" }}>Entrar com convite</div>
          </div>
          {tab === "create" ? (
            <>
              <input value={wsName} onChange={(e) => setWsName(e.target.value)} placeholder="Nome do funil (ex: Vendas 2026)" style={inputStyle} />
              <button disabled={busy} onClick={() => onCreate(wsName)} style={primaryBtnStyle}>{busy ? "..." : "Criar funil"}</button>
            </>
          ) : (
            <>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Seu nome (como vai aparecer pro time)" style={inputStyle} />
              <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Código do convite" style={{ ...inputStyle, textTransform: "uppercase" }} />
              <button disabled={busy} onClick={() => onJoin(displayName, code)} style={primaryBtnStyle}>{busy ? "..." : "Entrar no funil"}</button>
            </>
          )}
          {error && <div style={{ background: "rgba(226,72,63,0.1)", border: "1px solid rgba(226,72,63,0.3)", color: "#f87171", padding: "10px 14px", borderRadius: 10, fontSize: 12.5, marginTop: 10 }}>{error}</div>}
        </div>
      </div>
    </div>
  );
}

function WorkspaceMenu({ workspaceName, show, setShow, onSwitch, onLogout, onInvite, inviteCode, clearInvite, copied, setCopied }) {
  return (
    <>
      <button
        onClick={() => setShow((s) => !s)}
        title={workspaceName}
        style={{ position: "fixed", top: 10, right: 10, zIndex: 999, width: 34, height: 34, borderRadius: "50%", background: "rgba(20,20,20,0.85)", backdropFilter: "blur(8px)", border: "1px solid rgba(255,255,255,0.12)", color: "#a3e635", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
      >
        <Users size={15} />
      </button>
      {show && (
        <div style={{ position: "fixed", top: 50, right: 10, zIndex: 999, width: 230, background: "#161611", border: "1px solid #26261f", borderRadius: 16, padding: 14, boxShadow: "0 20px 50px -12px rgba(0,0,0,0.5)" }}>
          <div style={{ color: "#767670", fontSize: 10.5, fontWeight: 700, marginBottom: 10, textTransform: "uppercase" }}>{workspaceName}</div>
          {!inviteCode ? (
            <button onClick={onInvite} style={menuBtnStyle}><Copy size={13} /> Convidar pro funil</button>
          ) : (
            <div style={{ background: "#1e1e17", borderRadius: 10, padding: "10px 12px", marginBottom: 8 }}>
              <div style={{ fontFamily: "monospace", fontSize: 16, fontWeight: 800, letterSpacing: 2, color: "#a3e635", textAlign: "center", marginBottom: 6 }}>{inviteCode}</div>
              <button
                onClick={() => { navigator.clipboard.writeText(inviteCode); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                style={{ ...menuBtnStyle, justifyContent: "center", background: "#26261f" }}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copiado!" : "Copiar código"}
              </button>
              <button onClick={clearInvite} style={{ ...menuBtnStyle, justifyContent: "center", color: "#767670" }}>Fechar</button>
            </div>
          )}
          <button onClick={onSwitch} style={menuBtnStyle}><ArrowLeftRight size={13} /> Trocar de funil</button>
          <button onClick={onLogout} style={{ ...menuBtnStyle, color: "#f87171" }}><LogOut size={13} /> Sair</button>
        </div>
      )}
    </>
  );
}

const inputStyle = {
  width: "100%", padding: "12px 14px", borderRadius: 12, border: "1.5px solid #2a2a22",
  fontSize: 14, marginBottom: 10, background: "#0f0f0b", color: "white", outline: "none",
};
const primaryBtnStyle = {
  width: "100%", padding: "12px 18px", borderRadius: 12, border: "none",
  background: "linear-gradient(135deg, #84cc16, #a3e635)", color: "#0f1a03",
  fontWeight: 700, fontSize: 13.5, cursor: "pointer",
};
const linkBtnStyle = {
  width: "100%", padding: 10, background: "transparent", border: "none",
  color: "#a3e635", fontSize: 12.5, cursor: "pointer", marginTop: 4,
};
const menuBtnStyle = {
  width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "9px 10px",
  borderRadius: 9, border: "none", background: "transparent", color: "#e5e5e0",
  fontSize: 12.5, fontWeight: 600, cursor: "pointer", marginBottom: 4, textAlign: "left",
};

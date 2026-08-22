import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient.js";
import FunnioApp from "./FunnioApp.jsx";
import { LogOut, Users, ArrowLeftRight, Copy, Check } from "lucide-react";

// ════════════════════════════════════════════════════════════════════════
// Ponte de armazenamento: o CRM (FunnioApp) já foi construído em cima de uma
// API window.storage.get/set (pensada originalmente pra artefatos do Claude).
// Aqui a implementamos de verdade, salvando cada chave como uma linha no
// Supabase, isolada por workspace_id — sem precisar tocar na lógica interna
// do CRM, que continua igual (dashboard, leads, metas, assistente etc.)
// ════════════════════════════════════════════════════════════════════════
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
  const [session, setSession] = useState(undefined); // undefined = ainda checando
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
  const [pendingInviteCode, setPendingInviteCode] = useState("");

  // Se a pessoa abriu o link de convite (ex: funnio.vercel.app/?convite=ABC123),
  // já deixa o código pronto e a aba de "entrar com convite" selecionada.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const codeFromUrl = params.get("convite");
    if (codeFromUrl) {
      setPendingInviteCode(codeFromUrl.toUpperCase());
      setTab("join");
    }
  }, []);

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

  // Reabrir automaticamente o último workspace usado, se a pessoa ainda for membro dele
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

  const [showMembers, setShowMembers] = useState(false);
  const [members, setMembers] = useState([]);
  const [membersError, setMembersError] = useState("");

  const loadMembers = useCallback(async () => {
    if (!activeWorkspace) return;
    const { data, error } = await supabase.rpc("crm_workspace_members", { ws_id: activeWorkspace.id });
    if (!error) setMembers(data || []);
  }, [activeWorkspace]);

  // Carrega os membros também assim que o workspace abre (não só quando o painel é aberto),
  // pra "Gerenciar SDRs" já saber de cara quem tem login de verdade no funil.
  useEffect(() => {
    if (activeWorkspace && bridgeReady) loadMembers();
  }, [activeWorkspace, bridgeReady, loadMembers]);

  const syncMemberAvatar = async (displayName, avatarUrl) => {
    await supabase.rpc("crm_update_member_avatar_by_name", {
      ws_id: activeWorkspace.id, target_name: displayName, new_avatar_url: avatarUrl,
    });
    loadMembers();
  };

  const handleOpenMembers = async () => {
    setShowMenu(false);
    setShowMembers(true);
    setMembersError("");
    await loadMembers();
  };

  const handleRemoveMember = async (targetUserId) => {
    setMembersError("");
    const { error } = await supabase.rpc("crm_remove_member", { ws_id: activeWorkspace.id, target_user_id: targetUserId });
    if (error) { setMembersError(error.message); return; }
    await loadMembers();
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    localStorage.removeItem("funnio_active_ws");
    setActiveWorkspace(null);
  };

  // Trocar de funil precisa esquecer o "último funil salvo", senão o app reabre
  // o mesmo funil sozinho na hora seguinte (efeito de auto-retomar) e parece que
  // o botão não fez nada.
  const handleSwitchWorkspace = () => {
    localStorage.removeItem("funnio_active_ws");
    setActiveWorkspace(null);
  };

  // ═════════ Telas ═════════
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
        defaultCode={pendingInviteCode}
      />
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <FunnioApp
        key={activeWorkspace.id}
        authMembers={members}
        onSyncMemberAvatar={syncMemberAvatar}
        currentUserId={session.user.id}
        workspaceName={activeWorkspace.name}
        onSwitchWorkspace={handleSwitchWorkspace}
        isOwner={activeWorkspace.role === "owner"}
      />
      <WorkspaceMenu
        workspaceName={activeWorkspace.name}
        show={showMenu}
        setShow={setShowMenu}
        onSwitch={() => { handleSwitchWorkspace(); setShowMenu(false); }}
        onLogout={handleLogout}
        onMembers={handleOpenMembers}
      />
      {showMembers && (
        <MembersPanel
          members={members}
          isOwner={activeWorkspace.role === "owner"}
          myUserId={session.user.id}
          error={membersError}
          onRemove={handleRemoveMember}
          onClose={() => setShowMembers(false)}
          onInvite={handleCreateInvite}
          inviteCode={inviteCode}
          clearInvite={() => setInviteCode("")}
          copied={copied}
          setCopied={setCopied}
        />
      )}
    </div>
  );
}

function CenteredMessage({ children }) {
  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0a0a", color: "#9a9aa3", fontFamily: "Arial, sans-serif", fontSize: 14 }}>
      {children}
    </div>
  );
}

function AuthScreen({ mode, setMode, onSubmit, error, busy }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const isLogin = mode === "login";
  return (
    <div style={{ position: "fixed", inset: 0, background: "linear-gradient(135deg, #4c3fd7 0%, #6d5ef8 32%, #9b6ff5 60%, #c084f5 100%)", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px 20px calc(20px + env(safe-area-inset-bottom)) 20px", fontFamily: '"Open Sans", Arial, sans-serif', overflow: "hidden" }}>
      <style>{`
        @keyframes funnioBlobFloat1 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(30px, -40px) scale(1.12); }
          66% { transform: translate(-20px, 20px) scale(0.94); }
        }
        @keyframes funnioBlobFloat2 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          50% { transform: translate(-35px, -25px) scale(1.15); }
        }
        @keyframes funnioBlobFloat3 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          40% { transform: translate(25px, 30px) scale(0.9); }
          80% { transform: translate(-15px, -15px) scale(1.08); }
        }
        @keyframes funnioShimmer {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 0.9; }
        }
      `}</style>
      <div style={{ position: "absolute", top: "-10%", left: "-15%", width: 420, height: 420, borderRadius: "50%", background: "radial-gradient(circle, rgba(255,255,255,0.35) 0%, rgba(196,132,245,0) 70%)", filter: "blur(10px)", animation: "funnioBlobFloat1 14s ease-in-out infinite", pointerEvents: "none" }} />
      <div style={{ position: "absolute", bottom: "-15%", right: "-10%", width: 460, height: 460, borderRadius: "50%", background: "radial-gradient(circle, rgba(255,214,255,0.4) 0%, rgba(109,94,248,0) 70%)", filter: "blur(10px)", animation: "funnioBlobFloat2 18s ease-in-out infinite", pointerEvents: "none" }} />
      <div style={{ position: "absolute", top: "35%", right: "8%", width: 260, height: 260, borderRadius: "50%", background: "radial-gradient(circle, rgba(163,230,53,0.28) 0%, rgba(163,230,53,0) 70%)", filter: "blur(10px)", animation: "funnioBlobFloat3 16s ease-in-out infinite", pointerEvents: "none" }} />
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 50% 0%, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0) 55%)", animation: "funnioShimmer 6s ease-in-out infinite", pointerEvents: "none" }} />
      <div style={{ width: "100%", maxWidth: 360, position: "relative", zIndex: 1 }}>
        <img src="/logo-v2.png" alt="Funnio" style={{ height: 92, width: "auto", display: "block", margin: "0 auto 18px", filter: "drop-shadow(0 10px 26px rgba(30,20,80,0.4))" }} />
        <h1 style={{ textAlign: "center", color: "#ffffff", fontSize: 24, fontWeight: 800, margin: "0 0 4px", textShadow: "0 2px 12px rgba(30,20,80,0.3)" }}>Funnio</h1>
        <div style={{ textAlign: "center", color: "rgba(255,255,255,0.85)", fontSize: 13, marginBottom: 24, textShadow: "0 1px 8px rgba(30,20,80,0.25)" }}>{isLogin ? "Entre na sua conta" : "Crie sua conta"}</div>
        <div style={{ background: "rgba(255,255,255,0.94)", backdropFilter: "blur(28px) saturate(180%)", border: "1px solid rgba(255,255,255,0.9)", borderRadius: 20, padding: 22, boxShadow: "0 30px 80px -20px rgba(30,20,80,0.55)" }}>
          {error && <div style={{ background: "rgba(220,38,38,0.08)", border: "1px solid rgba(220,38,38,0.25)", color: "#dc2626", padding: "10px 14px", borderRadius: 10, fontSize: 12.5, marginBottom: 14 }}>{error}</div>}

          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="seu@email.com" style={inputStyle} />
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Senha (mín. 6 caracteres)" style={{ ...inputStyle, marginBottom: 16 }} onKeyDown={(e) => e.key === "Enter" && onSubmit(email, password)} />
          <button disabled={busy} onClick={() => onSubmit(email, password)} style={primaryBtnStyle}>{busy ? "..." : isLogin ? "Entrar" : "Criar conta"}</button>
          <button onClick={() => setMode(isLogin ? "signup" : "login")} style={linkBtnStyle}>{isLogin ? "Não tem conta? Criar uma" : "Já tem conta? Entrar"}</button>
        </div>
      </div>
    </div>
  );
}

function WorkspacePicker({ email, workspaces, onOpen, onCreate, onJoin, onLogout, error, busy, tab, setTab, defaultCode }) {
  const [wsName, setWsName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [code, setCode] = useState(defaultCode || "");
  const wsColors = ["#6d5ef8", "#a3e635", "#f59e0b", "#38bdf8", "#ec4899"];
  return (
    <div style={{ position: "fixed", inset: 0, background: "linear-gradient(135deg, #f5f3ff 0%, #eef2ff 35%, #fdf2f8 100%)", fontFamily: '"Open Sans", Arial, sans-serif', display: "flex", flexDirection: "column", overflow: "hidden auto" }}>
      <button onClick={onLogout} style={{ position: "absolute", top: "calc(20px + env(safe-area-inset-top))", right: 22, background: "transparent", border: "none", color: "#6d5ef8", fontSize: 12.5, fontWeight: 600, cursor: "pointer", zIndex: 2 }}>Sair</button>

      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "60px 20px 40px" }}>
        <div style={{ maxWidth: 420, width: "100%", position: "relative", zIndex: 1 }}>
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <img src="/logo-v2.png" alt="Funnio" style={{ height: 76, width: "auto", display: "block", margin: "0 auto 16px", filter: "drop-shadow(0 8px 20px rgba(109,94,248,0.28))" }} />
            <h1 style={{ color: "#14141a", fontSize: 22, fontWeight: 800, margin: "0 0 4px" }}>Funnio</h1>
            <div style={{ color: "#6d5ef8", fontSize: 12.5, fontWeight: 600, marginBottom: 2 }}>Seu funil de vendas</div>
            <div style={{ color: "#8a8a93", fontSize: 12 }}>{email}</div>
          </div>

          {workspaces.length > 0 && (
            <div style={{ background: "rgba(255,255,255,0.9)", backdropFilter: "blur(28px) saturate(180%)", border: "1px solid rgba(255,255,255,0.9)", borderRadius: 20, padding: 18, marginBottom: 18, boxShadow: "0 30px 70px -24px rgba(109,94,248,0.3)" }}>
              <div style={{ color: "#8a8a93", fontSize: 11, fontWeight: 700, letterSpacing: 0.6, marginBottom: 12, textTransform: "uppercase" }}>Seus funis</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {workspaces.map((w, i) => (
                  <div
                    key={w.id}
                    onClick={() => onOpen(w)}
                    style={{ display: "flex", alignItems: "center", gap: 12, background: "#f6f7f9", border: "1px solid #eef0f3", borderRadius: 14, padding: "12px 14px", cursor: "pointer", transition: "border-color 0.15s ease" }}
                  >
                    <div style={{ width: 38, height: 38, borderRadius: 11, background: wsColors[i % wsColors.length] + "22", color: wsColors[i % wsColors.length], display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 15, flexShrink: 0 }}>
                      {w.name.charAt(0).toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: "#14141a", fontWeight: 700, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.name}</div>
                      <div style={{ color: "#8a8a93", fontSize: 11 }}>{w.member_count} pessoa{w.member_count === 1 ? "" : "s"} · {w.role === "owner" ? "dono" : "membro"}</div>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); onOpen(w); }} style={{ background: "#a3e635", color: "#0f1a03", border: "none", borderRadius: 9, padding: "8px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>Entrar</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ background: "rgba(255,255,255,0.9)", backdropFilter: "blur(28px) saturate(180%)", border: "1px solid rgba(255,255,255,0.9)", borderRadius: 20, padding: 20, boxShadow: "0 30px 70px -24px rgba(109,94,248,0.3)" }}>
            <div style={{ display: "flex", gap: 4, marginBottom: 18, background: "#f1f2f5", borderRadius: 12, padding: 4 }}>
              <button onClick={() => setTab("create")} style={{ flex: 1, textAlign: "center", padding: "9px 8px", borderRadius: 9, border: "none", fontSize: 12.5, fontWeight: 700, cursor: "pointer", background: tab === "create" ? "white" : "transparent", color: tab === "create" ? "#5b8c0a" : "#8a8a93", boxShadow: tab === "create" ? "0 2px 8px -3px rgba(20,20,26,0.2)" : "none", transition: "all 0.15s ease" }}>Criar novo funil</button>
              <button onClick={() => setTab("join")} style={{ flex: 1, textAlign: "center", padding: "9px 8px", borderRadius: 9, border: "none", fontSize: 12.5, fontWeight: 700, cursor: "pointer", background: tab === "join" ? "white" : "transparent", color: tab === "join" ? "#5b8c0a" : "#8a8a93", boxShadow: tab === "join" ? "0 2px 8px -3px rgba(20,20,26,0.2)" : "none", transition: "all 0.15s ease" }}>Entrar com convite</button>
            </div>
            {tab === "create" ? (
              <>
                <div style={{ fontSize: 11.5, color: "#8a8a93", marginBottom: 10 }}>Dá um nome pro seu novo funil de vendas.</div>
                <input value={wsName} onChange={(e) => setWsName(e.target.value)} placeholder="Nome do funil (ex: Vendas 2026)" style={inputStyle} />
                <button disabled={busy} onClick={() => onCreate(wsName)} style={primaryBtnStyle}>{busy ? "..." : "Criar funil"}</button>
              </>
            ) : (
              <>
                {defaultCode && (
                  <div style={{ background: "rgba(101,163,13,0.1)", border: "1px solid rgba(101,163,13,0.3)", color: "#4d7c0f", padding: "9px 12px", borderRadius: 10, fontSize: 11.5, marginBottom: 12 }}>
                    Código {defaultCode} preenchido automaticamente pelo link. Só falta seu nome!
                  </div>
                )}
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Seu nome (como vai aparecer pro time)" style={inputStyle} />
                <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Código do convite" style={{ ...inputStyle, textTransform: "uppercase" }} />
                <button disabled={busy} onClick={() => onJoin(displayName, code)} style={primaryBtnStyle}>{busy ? "..." : "Entrar no funil"}</button>
              </>
            )}
            {error && <div style={{ background: "rgba(220,38,38,0.08)", border: "1px solid rgba(220,38,38,0.25)", color: "#dc2626", padding: "10px 14px", borderRadius: 10, fontSize: 12.5, marginTop: 10 }}>{error}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkspaceMenu({ workspaceName, show, setShow, onSwitch, onLogout, onMembers }) {
  return (
    <>
      <button
        onClick={() => setShow((s) => !s)}
        title={workspaceName}
        style={{ position: "fixed", top: "calc(12px + env(safe-area-inset-top))", right: 12, zIndex: 999999, width: 40, height: 40, borderRadius: "50%", background: "#141416", backdropFilter: "blur(8px)", border: "2px solid #a3e635", color: "#a3e635", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: "0 6px 18px -6px rgba(0,0,0,0.5)" }}
      >
        <Users size={17} />
      </button>
      {show && (
        <div style={{ position: "fixed", top: "calc(58px + env(safe-area-inset-top))", right: 12, zIndex: 999999, width: 220, background: "#161611", border: "1px solid #26261f", borderRadius: 16, padding: 14, boxShadow: "0 20px 50px -12px rgba(0,0,0,0.5)" }}>
          <div style={{ color: "#767670", fontSize: 10.5, fontWeight: 700, marginBottom: 10, textTransform: "uppercase" }}>{workspaceName}</div>
          <button onClick={onMembers} style={menuBtnStyle}><Users size={13} /> Gerenciar membros</button>
          <button onClick={onSwitch} style={menuBtnStyle}><ArrowLeftRight size={13} /> Trocar de funil</button>
          <button onClick={onLogout} style={{ ...menuBtnStyle, color: "#f87171" }}><LogOut size={13} /> Sair</button>
        </div>
      )}
    </>
  );
}

// Painel único de gerenciamento: convidar (código + link + WhatsApp), ver todo mundo
// que já está no funil, e remover alguém (só o dono vê o botão de remover).
function MembersPanel({ members, isOwner, myUserId, error, onRemove, onClose, onInvite, inviteCode, clearInvite, copied, setCopied }) {
  const [copiedLink, setCopiedLink] = useState(false);
  const inviteLink = inviteCode ? `${window.location.origin}/?convite=${inviteCode}` : "";
  const whatsappText = inviteCode
    ? `Entra no nosso funil no Funnio! Código: ${inviteCode} — ou clica direto aqui: ${inviteLink}`
    : "";

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,10,40,0.5)", zIndex: 999998, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 480, maxHeight: "85vh", overflowY: "auto", background: "#161611", borderRadius: "22px 22px 0 0", padding: 22, fontFamily: '"Open Sans", Arial, sans-serif' }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: "white" }}>Gerenciar funil</div>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: 10, border: "1px solid #26261f", background: "transparent", color: "#e5e5e0", cursor: "pointer", fontSize: 14 }}>✕</button>
        </div>

        {/* Convidar */}
        <div style={{ fontSize: 11, fontWeight: 700, color: "#767670", textTransform: "uppercase", marginBottom: 8 }}>Adicionar pessoa</div>
        {!inviteCode ? (
          <button onClick={onInvite} style={{ ...menuBtnStyle, justifyContent: "center", background: "#26261f", marginBottom: 20 }}><Copy size={13} /> Gerar convite</button>
        ) : (
          <div style={{ background: "#1e1e17", borderRadius: 12, padding: "12px 14px", marginBottom: 20 }}>
            <div style={{ fontFamily: "monospace", fontSize: 18, fontWeight: 800, letterSpacing: 2, color: "#a3e635", textAlign: "center", marginBottom: 10 }}>{inviteCode}</div>
            <a
              href={`https://wa.me/?text=${encodeURIComponent(whatsappText)}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ ...menuBtnStyle, justifyContent: "center", background: "#22c55e", color: "white", textDecoration: "none", marginBottom: 4 }}
            >
              Enviar pelo WhatsApp
            </a>
            <button
              onClick={() => { navigator.clipboard.writeText(inviteLink); setCopiedLink(true); setTimeout(() => setCopiedLink(false), 1500); }}
              style={{ ...menuBtnStyle, justifyContent: "center", background: "#26261f" }}
            >
              {copiedLink ? <Check size={13} /> : <Copy size={13} />} {copiedLink ? "Link copiado!" : "Copiar link"}
            </button>
            <button
              onClick={() => { navigator.clipboard.writeText(inviteCode); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              style={{ ...menuBtnStyle, justifyContent: "center", background: "transparent", color: "#767670" }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copiado!" : "Copiar só o código"}
            </button>
            <button onClick={clearInvite} style={{ ...menuBtnStyle, justifyContent: "center", color: "#767670" }}>Fechar convite</button>
          </div>
        )}

        {/* Lista de membros */}
        <div style={{ fontSize: 11, fontWeight: 700, color: "#767670", textTransform: "uppercase", marginBottom: 8 }}>Quem já está no funil ({members.length})</div>
        {error && <div style={{ background: "rgba(226,72,63,0.1)", border: "1px solid rgba(226,72,63,0.3)", color: "#f87171", padding: "10px 14px", borderRadius: 10, fontSize: 12.5, marginBottom: 12 }}>{error}</div>}
        {members.length === 0 ? (
          <div style={{ color: "#767670", fontSize: 13 }}>Carregando membros...</div>
        ) : (
          members.map((m) => (
            <div key={m.user_id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#1e1e17", borderRadius: 12, padding: "10px 12px", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 30, height: 30, borderRadius: "50%", background: m.color || "#6d5ef8", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontWeight: 700, fontSize: 12 }}>
                  {(m.display_name || "?").charAt(0).toUpperCase()}
                </div>
                <div>
                  <div style={{ color: "white", fontWeight: 700, fontSize: 13 }}>{m.display_name}{m.user_id === myUserId ? " (você)" : ""}</div>
                  <div style={{ color: "#767670", fontSize: 11 }}>{m.role === "owner" ? "Dono do funil" : "Membro"}</div>
                </div>
              </div>
              {isOwner && m.user_id !== myUserId && (
                <button onClick={() => onRemove(m.user_id)} style={{ border: "none", background: "rgba(239,68,68,0.12)", color: "#f87171", fontSize: 11, fontWeight: 700, padding: "6px 10px", borderRadius: 8, cursor: "pointer" }}>
                  Remover
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const inputStyle = {
  width: "100%", padding: "12px 14px", borderRadius: 12, border: "1.5px solid #e2e4e9",
  fontSize: 14, marginBottom: 10, background: "#f6f7f9", color: "#14141a", outline: "none",
};
const primaryBtnStyle = {
  width: "100%", padding: "12px 18px", borderRadius: 12, border: "none",
  background: "linear-gradient(135deg, #84cc16, #a3e635)", color: "#0f1a03",
  fontWeight: 700, fontSize: 13.5, cursor: "pointer",
};
const linkBtnStyle = {
  width: "100%", padding: 10, background: "transparent", border: "none",
  color: "#5b8c0a", fontSize: 12.5, fontWeight: 700, cursor: "pointer", marginTop: 4,
};
const menuBtnStyle = {
  width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "9px 10px",
  borderRadius: 9, border: "none", background: "transparent", color: "#e5e5e0",
  fontSize: 12.5, fontWeight: 600, cursor: "pointer", marginBottom: 4, textAlign: "left",
};

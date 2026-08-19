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

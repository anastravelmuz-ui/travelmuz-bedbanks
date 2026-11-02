// Pages comptes : connexion, mot de passe, back-office. Aucun jeton stocké dans le navigateur (cookie HttpOnly).
const MESSAGES = {
  INVALID_CREDENTIALS: 'Email ou mot de passe incorrect. Après 5 échecs, le compte est bloqué 15 minutes.',
  STORAGE_NOT_CONFIGURED: 'La base des comptes n’est pas encore activée sur cet hébergement.',
  AUTHENTICATION_REQUIRED: 'Connexion requise.', ADMIN_REQUIRED: 'Réservé aux administrateurs.',
  PASSWORD_TOO_SHORT: 'Le mot de passe doit contenir au moins 12 caractères.', PASSWORD_TOO_LONG: 'Mot de passe trop long (128 caractères maximum).',
  LINK_INVALID: 'Ce lien est invalide, déjà utilisé ou expiré. Demandez-en un nouveau à un administrateur.',
  EMAIL_INVALID: 'Adresse email invalide.', EMAIL_EXISTS: 'Un compte existe déjà avec cet email.', ROLE_INVALID: 'Rôle invalide.',
  LAST_ADMIN: 'Impossible : il doit rester au moins un administrateur actif.', SELF_FORBIDDEN: 'Vous ne pouvez pas désactiver ou supprimer votre propre compte.',
  USER_INACTIVE: 'Réactivez d’abord ce compte.', USER_NOT_FOUND: 'Compte introuvable.', ALREADY_INITIALIZED: 'Le compte administrateur existe déjà : connectez-vous.',
  ORIGIN_REJECTED: 'Requête refusée.', SETUP_DISABLED: 'Installation désactivée : aucun code d’installation n’est défini dans Cloudflare.', SETUP_CODE_INVALID: 'Code d’installation incorrect.', NETWORK: 'Serveur injoignable. Réessayez.',
};
const say = code => MESSAGES[code] ?? 'Une erreur est survenue. Réessayez.';
const $ = id => document.getElementById(id);
async function api(path, body) {
  try {
    const r = await fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = {}; try { data = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, data, error: r.ok ? null : data.error ?? 'SERVER_ERROR' };
  } catch { return { ok: false, status: 0, data: {}, error: 'NETWORK' }; }
}
function show(el, text, kind = 'err') { el.textContent = text; el.className = 'msg ' + kind; el.hidden = false; }
function busy(form, on) { form.querySelectorAll('button').forEach(b => { b.disabled = on; }); }
const when = ms => new Date(ms).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
function linkBox(target, label, link, expiresAt) {
  target.replaceChildren();
  const p = document.createElement('p'); p.className = 'msg ok';
  p.textContent = `${label} Lien à usage unique, valable jusqu’au ${when(expiresAt)}. Transmettez-le à la personne par un canal sûr ; il n’est affiché qu’une fois.`;
  const box = document.createElement('div'); box.className = 'linkbox';
  const input = Object.assign(document.createElement('input'), { readOnly: true, value: link }); input.setAttribute('aria-label', 'Lien d’activation');
  const copy = Object.assign(document.createElement('button'), { type: 'button', className: 'btn secondary', textContent: 'Copier' });
  copy.onclick = async () => { try { await navigator.clipboard.writeText(link); copy.textContent = 'Copié'; } catch { input.select(); } };
  box.append(input, copy); target.append(p, box);
}

// ---- Connexion ----
if ($('login')) {
  const me = await api('/api/auth/me');
  if (me.ok) location.replace('/');
  if (me.error === 'STORAGE_NOT_CONFIGURED') show($('login-msg'), say('STORAGE_NOT_CONFIGURED'), 'info');
  $('login').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.currentTarget; busy(f, true);
    const r = await api('/api/auth/login', { email: f.email.value, password: f.password.value });
    busy(f, false);
    if (r.ok) { location.replace(r.data.user.role === 'admin' ? '/admin.html' : '/'); return; }
    f.password.value = ''; show($('login-msg'), say(r.error));
  });
  $('show-forgot').onclick = () => { $('forgot').hidden = !$('forgot').hidden; };
  $('forgot').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.currentTarget; busy(f, true);
    const r = await api('/api/auth/forgot', { email: f.email.value }); busy(f, false);
    show($('forgot-msg'), r.ok && r.data.emailDelivery
      ? 'Si ce compte existe, un email de réinitialisation vient d’être envoyé.'
      : r.ok ? 'L’envoi d’emails n’est pas encore activé : demandez un lien de réinitialisation à un administrateur.' : say(r.error), r.ok ? 'info' : 'err');
  });
  $('bootstrap').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.currentTarget; busy(f, true);
    const r = await api('/api/auth/bootstrap', { code: f.code.value }); busy(f, false); f.code.value = '';
    if (r.ok) linkBox($('bootstrap-out'), 'Compte administrateur créé.', r.data.link, r.data.expiresAt);
    else { $('bootstrap-out').replaceChildren(); const p = document.createElement('p'); $('bootstrap-out').append(p); show(p, say(r.error)); }
  });
  $('show-setup').onclick = () => { $('first-run').hidden = !$('first-run').hidden; };
}

// ---- Choix du mot de passe (invitation ou réinitialisation) ----
if ($('setpwd')) {
  const token = new URLSearchParams(location.hash.slice(1)).get('t') ?? '';
  history.replaceState(null, '', location.pathname); // retire le jeton de la barre d'adresse et de l'historique
  const info = token ? await api('/api/auth/link', { token }) : { ok: false, error: 'LINK_INVALID' };
  if (!info.ok) { $('for').textContent = ''; show($('pwd-msg'), say(info.error)); }
  else {
    $('for').textContent = `${info.data.purpose === 'invite' ? 'Activation du compte' : 'Réinitialisation'} : ${info.data.email}`;
    $('setpwd').hidden = false;
    $('setpwd').addEventListener('submit', async e => {
      e.preventDefault(); const f = e.currentTarget;
      if (f.password.value !== f.confirm.value) { show($('pwd-msg'), 'Les deux mots de passe ne correspondent pas.'); return; }
      busy(f, true); const r = await api('/api/auth/set-password', { token, password: f.password.value }); busy(f, false);
      if (r.ok) { f.hidden = true; const m = $('pwd-msg'); m.replaceChildren('Mot de passe enregistré. ', Object.assign(document.createElement('a'), { href: '/connexion.html', textContent: 'Se connecter' })); m.className = 'msg ok'; m.hidden = false; }
      else show($('pwd-msg'), say(r.error));
    });
  }
}

// ---- Back-office ----
if ($('admin')) {
  const out = $('admin-msg');
  async function load() {
    const r = await api('/api/admin');
    if (!r.ok) {
      $('admin').hidden = true;
      if (r.error === 'AUTHENTICATION_REQUIRED') { location.replace('/connexion.html'); return; }
      show(out, say(r.error), r.error === 'STORAGE_NOT_CONFIGURED' ? 'info' : 'err'); return;
    }
    out.hidden = true; $('admin').hidden = false; $('logout').hidden = false;
    const self = r.data.users.find(u => u.id === r.data.me); if (self) $('who').textContent = self.email;
    $('rows').replaceChildren(...r.data.users.map(u => row(u, u.id === r.data.me)));
  }
  function tag(text, cls = '') { return Object.assign(document.createElement('span'), { className: 'tag ' + cls, textContent: text }); }
  function action(label, cls, fn) { return Object.assign(document.createElement('button'), { type: 'button', className: 'btn ' + cls, textContent: label, onclick: fn }); }
  async function run(body, label) {
    const r = await api('/api/admin', body);
    if (!r.ok) { $('row-out').replaceChildren(); show(out, say(r.error)); return; }
    out.hidden = true;
    if (r.data.link) linkBox($('row-out'), `${label} ${r.data.user.email}.`, r.data.link, r.data.expiresAt); else $('row-out').replaceChildren();
    await load();
  }
  function row(u, isSelf) {
    const tr = document.createElement('tr');
    const td = (...kids) => { const c = document.createElement('td'); c.append(...kids); return c; };
    const state = !u.active ? tag('Désactivé', 'off') : !u.hasPassword ? tag('Activation en attente', 'wait') : tag('Actif');
    const acts = document.createElement('div'); acts.className = 'row-actions';
    if (isSelf) acts.append(Object.assign(document.createElement('span'), { textContent: 'Votre compte' }));
    else {
      if (u.active) acts.append(action(u.hasPassword ? 'Lien de réinitialisation' : 'Nouveau lien d’activation', 'secondary', () => run({ action: 'link', id: u.id }, 'Lien créé pour')));
      acts.append(u.active ? action('Désactiver', 'secondary', () => run({ action: 'deactivate', id: u.id }, ''))
                           : action('Réactiver', 'secondary', () => run({ action: 'activate', id: u.id }, '')));
      acts.append(action('Supprimer', 'danger', () => { if (confirm(`Supprimer définitivement le compte ${u.email} ?`)) run({ action: 'delete', id: u.id }, ''); }));
    }
    tr.append(td(u.email), td(tag(u.role === 'admin' ? 'Administrateur' : 'Agent', u.role === 'admin' ? 'admin' : '')), td(state), td(acts));
    return tr;
  }
  $('create').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.currentTarget; busy(f, true);
    const r = await api('/api/admin', { action: 'create', email: f.email.value, role: f.role.value }); busy(f, false);
    if (r.ok) { linkBox($('create-out'), `Compte créé pour ${r.data.user.email}.`, r.data.link, r.data.expiresAt); f.reset(); await load(); }
    else { $('create-out').replaceChildren(); show(out, say(r.error)); }
  });
  $('logout').onclick = async () => { await api('/api/auth/logout', {}); location.replace('/connexion.html'); };
  await load();
}

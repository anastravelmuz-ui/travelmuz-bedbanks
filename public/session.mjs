// En-tête des pages privées : agent connecté, lien Administration (admins), déconnexion.
const r = await fetch('/api/auth/me', { credentials: 'same-origin' }).catch(() => null);
if (r && r.status === 401) location.replace('/connexion.html');
const user = r && r.ok ? (await r.json()).user : null;
const slot = document.querySelector('header .private');
if (user && slot) {
  const nav = document.querySelector('header nav');
  if (user.role === 'admin' && nav && !nav.querySelector('a[href="/admin.html"]')) {
    nav.append(Object.assign(document.createElement('a'), { href: '/admin.html', textContent: 'Administration' }));
  }
  const out = Object.assign(document.createElement('button'), { type: 'button', className: 'text-button', textContent: 'Se déconnecter' });
  out.onclick = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    location.replace('/connexion.html');
  };
  slot.replaceChildren(document.createTextNode(user.email + ' · '), out);
}

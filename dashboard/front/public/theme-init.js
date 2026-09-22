// Apply the saved theme before first paint to avoid a flash of the wrong one.
try {
  var saved = localStorage.getItem('dbmesh-theme')
  if (saved === 'dark' || (saved !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark')
  }
} catch (error) {
  // Storage can be blocked; the system theme then applies.
}

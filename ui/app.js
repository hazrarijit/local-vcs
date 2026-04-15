// Global Application Scripts
document.addEventListener('DOMContentLoaded', () => {
    // Check local storage for theme
    const savedTheme = localStorage.getItem('vcs-theme') || 'dark';
    if (savedTheme === 'light') {
        document.body.classList.add('light-theme');
    }
});

function toggleTheme() {
    const isLight = document.body.classList.toggle('light-theme');
    localStorage.setItem('vcs-theme', isLight ? 'light' : 'dark');
}

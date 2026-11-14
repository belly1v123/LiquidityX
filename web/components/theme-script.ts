export const THEME_KEY = "lx-theme";

/** Runs before paint (inlined in <head>) so there's no flash of the wrong theme. */
export const themeScript = `(function(){try{var c=localStorage.getItem("${THEME_KEY}");var d=c==="dark"||(c!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=d?"dark":"light";}catch(e){}})();`;

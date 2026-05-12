// static/js/toast.js
(() => {
  function ensureRoot(){
    let r = document.querySelector('.toast-container');
    if (!r){
      r = document.createElement('div');
      r.className = 'toast-container';
      document.body.appendChild(r);
    }
    return r;
  }
  function toast(msg, kind='ok'){
    const root = ensureRoot();
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(()=> el.classList.add('hide'), 3000);
    setTimeout(()=> el.remove(), 3400);
  }
  window.toast = toast;
})();

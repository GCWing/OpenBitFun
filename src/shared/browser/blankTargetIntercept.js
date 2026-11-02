(function(){
  if(window.__openbitfun_blank_intercept){return;}
  window.__openbitfun_blank_intercept=true;
  document.addEventListener('click',function(e){
    var el=e.target;
    while(el&&el.tagName!=='A'){el=el.parentElement;}
    if(!el)return;
    var t=(el.getAttribute('target')||'').toLowerCase();
    if(t==='_blank'){
      e.preventDefault();
      e.stopPropagation();
      var href=el.href;
      if(href){location.href=href;}
    }
  },true);
})();

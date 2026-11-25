/* The marks are decoration added after the fact: the page is complete
     without this, so a blocked or slow script costs an icon, not content. */
  (function () {
    if (typeof window.coinIcon !== "function") return;
    var nodes = document.querySelectorAll(".mark[data-coin]");
    for (var i = 0; i < nodes.length; i++) {
      var big = !nodes[i].classList.contains("sm");
      nodes[i].innerHTML = window.coinIcon(nodes[i].getAttribute("data-coin"), big ? 40 : 20);
    }
  })();

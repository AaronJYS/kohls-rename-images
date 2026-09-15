const links = [...document.querySelectorAll(".tool-link")];

function showTool() {
  const pdf = location.hash === "#pdf-to-excel";
  document.body.dataset.tool = pdf ? "pdf" : "images";
  document.getElementById("image-tool").hidden = pdf;
  document.getElementById("pdf-tool").hidden = !pdf;
  document.title = pdf ? "AAFES PDF to Excel · JYS Enterprise" : "Kohl’s Image Renamer · JYS Enterprise";
  for (const link of links) {
    if ((link.hash === "#pdf-to-excel") === pdf) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

window.addEventListener("hashchange", showTool);
showTool();

const links = document.querySelectorAll(".tool-link");
const tools = {
  "#image-name-converter": { id: "image-tool", name: "images", title: "Kohl’s Image Renamer" },
  "#pdf-to-excel": { id: "pdf-tool", name: "pdf", title: "AAFES PDF to Excel" },
  "#hamricks-po-to-940": { id: "hamricks-tool", name: "hamricks", title: "Hamrick’s PO to 940" },
};

function showTool() {
  const hash = Object.hasOwn(tools, location.hash) ? location.hash : "#image-name-converter";
  const selected = tools[hash];
  document.body.dataset.tool = selected.name;
  for (const tool of Object.values(tools)) document.getElementById(tool.id).hidden = tool !== selected;
  document.title = `${selected.title} · JYS Enterprise`;
  for (const link of links) {
    if (link.hash === hash) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

window.addEventListener("hashchange", showTool);
showTool();

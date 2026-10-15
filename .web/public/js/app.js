import { api, setCsrfToken } from "./lib/fetchJson.js";
import * as dashboard from "./pages/dashboard.js";
import * as jobDetail from "./pages/jobDetail.js";
import * as newJobWizard from "./pages/newJobWizard.js";
import * as usageDashboard from "./pages/usageDashboard.js";
import * as doctorPage from "./pages/doctorPage.js";
import * as logViewer from "./pages/logViewer.js";
import * as tailView from "./pages/tailView.js";

const main = document.getElementById("main");
let currentDispose = null;

function parseRoute(hash) {
  const h = (hash || "#/").replace(/^#/, "") || "/";
  const [pathPart, queryPart] = h.split("?");
  const params = Object.fromEntries(new URLSearchParams(queryPart || ""));
  const segs = pathPart.split("/").filter(Boolean);
  return { segs, params };
}

function setActiveNav(hash) {
  document.querySelectorAll(".nav-link").forEach((a) => a.classList.remove("active"));
  const el = document.querySelector(`.nav-link[data-route="${hash}"]`);
  if (el) el.classList.add("active");
}

async function route() {
  if (currentDispose) {
    try {
      currentDispose();
    } catch (e) {
      /* page cleanup shouldn't block navigation */
    }
    currentDispose = null;
  }
  const { segs, params } = parseRoute(location.hash);

  try {
    if (segs.length === 0) {
      setActiveNav("#/");
      currentDispose = await dashboard.render(main, params);
    } else if (segs[0] === "new") {
      setActiveNav("#/new");
      currentDispose = await newJobWizard.render(main, params);
    } else if (segs[0] === "usage") {
      setActiveNav("#/usage");
      currentDispose = await usageDashboard.render(main, params);
    } else if (segs[0] === "doctor") {
      setActiveNav("#/doctor");
      currentDispose = await doctorPage.render(main, params);
    } else if (segs[0] === "jobs" && segs[1]) {
      const name = decodeURIComponent(segs[1]);
      if (segs[2] === "logs") currentDispose = await logViewer.render(main, { name, ...params });
      else if (segs[2] === "tail") currentDispose = await tailView.render(main, { name, ...params });
      else currentDispose = await jobDetail.render(main, { name, ...params });
    } else {
      main.innerHTML = `<div class="empty">Not found.</div>`;
    }
  } catch (err) {
    console.error(err);
    main.innerHTML = `<div class="banner error">${err && err.message ? err.message : String(err)}</div>`;
  }
}

async function bootstrap() {
  try {
    const status = await api("/api/auth/status");
    if (!status.authenticated) {
      window.location.href = "/login.html";
      return;
    }
    setCsrfToken(status.csrfToken);
  } catch (e) {
    window.location.href = "/login.html";
    return;
  }

  document.getElementById("logout-btn").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login.html";
  });

  window.addEventListener("hashchange", route);
  route();
}

bootstrap();

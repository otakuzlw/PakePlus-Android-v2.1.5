(function () {
  const STORAGE_KEY = "print_demo_api_base";

  const $ = (id) => document.getElementById(id);

  const apiWarn = $("apiWarn");
  const apiBaseInput = $("apiBase");
  const fileInput = $("fileInput");
  const previewWrap = $("previewWrap");
  const previewImg = $("previewImg");
  const uploadMsg = $("uploadMsg");
  const promptEl = $("prompt");
  const btnGenerate = $("btnGenerate");
  const genMsg = $("genMsg");
  const resultSection = $("resultSection");
  const resultImages = $("resultImages");
  const btnPrint = $("btnPrint");
  const statusText = $("statusText");
  const btnPing = $("btnPing");
  const pingMsg = $("pingMsg");

  let fileId = null;
  let lastResultUrl = null;
  let pollTimer = null;

  /** PakePlus / 本地 WebView：页面在 127.0.0.1:3358 等，API 在另一台机器的 :8000 */
  function isBundledApp() {
    const proto = window.location.protocol;
    if (proto === "file:") return true;
    const host = window.location.hostname;
    const port = window.location.port;
    if ((host === "127.0.0.1" || host === "localhost") && port && port !== "8000") {
      return true;
    }
    return false;
  }

  function normalizeBase(v) {
    return (v || "").trim().replace(/\/$/, "");
  }

  function resolveApiBase() {
    const v = normalizeBase(apiBaseInput.value);
    if (v) return v;
    if (!isBundledApp()) return "";
    return null;
  }

  function apiUrl(path) {
    const base = resolveApiBase();
    if (base === null) {
      throw new Error(
        "请先填写 Python 服务器地址，例如 http://192.168.1.100:8000（不能留空；127.0.0.1 是 PakePlus 本地页，不是 API）"
      );
    }
    return base ? base + path : path;
  }

  function updateApiWarn() {
    if (!apiWarn) return;
    if (isBundledApp() && !normalizeBase(apiBaseInput.value)) {
      apiWarn.classList.remove("hidden");
      apiWarn.textContent =
        "当前为 PakePlus/离线壳（端口 " +
        (window.location.port || "?") +
        "），API 不在本机。请填写运行 run.ps1 的电脑局域网 IP，或修改 web/config.json 后重新打包。";
    } else {
      apiWarn.classList.add("hidden");
    }
  }

  function setHint(el, text, type) {
    el.textContent = text || "";
    el.className = "hint" + (type ? " " + type : "");
  }

  function setStatus(text) {
    statusText.textContent = text;
  }

  function printImage(imageUrl) {
    if (!imageUrl) {
      alert("没有可打印的图片");
      return;
    }
    const w = window.open(imageUrl, "_blank");
    if (!w) {
      alert("请允许弹窗，或在此函数内实现你的打印 API\n图片地址：\n" + imageUrl);
    }
    console.log("[printImage] 待对接打印机, url=", imageUrl);
  }

  async function loadDefaultApiBase() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      apiBaseInput.value = saved;
      return;
    }

    const meta = document.querySelector('meta[name="api-base"]');
    if (meta && meta.content) {
      apiBaseInput.value = meta.content.trim();
      return;
    }

    try {
      const r = await fetch("config.json?t=" + Date.now());
      if (r.ok) {
        const cfg = await r.json();
        if (cfg && cfg.apiBase) {
          apiBaseInput.value = String(cfg.apiBase).trim();
        }
      }
    } catch (e) {
      console.warn("读取 config.json 失败（打包请确保包含该文件）", e);
    }
  }

  async function ping() {
    const base = resolveApiBase();
    if (base === null) {
      updateApiWarn();
      setHint(pingMsg, "请先填写服务器地址", "error");
      return;
    }

    localStorage.setItem(STORAGE_KEY, apiBaseInput.value.trim());
    setHint(pingMsg, "检测中… " + (base || location.origin));
    try {
      const url = apiUrl("/api/health");
      const r = await fetch(url);
      if (!r.ok) {
        let detail = "HTTP " + r.status;
        if (r.status === 404 && isBundledApp()) {
          detail +=
            " — 仍指向 PakePlus 本地？请填 http://电脑IP:8000，并在电脑上运行 run.ps1";
        }
        throw new Error(detail);
      }
      const data = await r.json();
      setHint(pingMsg, "已连接 · " + (base || location.origin) + " · 模型 " + (data.model || ""), "ok");
      updateApiWarn();
    } catch (e) {
      setHint(pingMsg, "连接失败: " + e.message, "error");
    }
  }

  async function uploadFile(file) {
    setHint(uploadMsg, "上传中…");
    fileId = null;
    btnGenerate.disabled = true;

    const fd = new FormData();
    fd.append("file", file);

    const r = await fetch(apiUrl("/api/upload"), { method: "POST", body: fd });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const detail = Array.isArray(data.detail)
        ? data.detail.map((x) => x.msg).join("; ")
        : data.detail;
      throw new Error(detail || r.statusText || "上传失败");
    }

    fileId = data.file_id;
    previewImg.src = apiUrl(data.preview_url);
    previewWrap.classList.remove("hidden");
    btnGenerate.disabled = false;
    setHint(uploadMsg, "上传成功", "ok");
    setStatus("已上传，可生成");
  }

  async function pollJob(jobId) {
    const r = await fetch(apiUrl("/api/jobs/" + jobId));
    const job = await r.json();
    if (!r.ok) throw new Error(job.detail || "查询任务失败");

    setStatus(job.status);

    if (job.status === "pending" || job.status === "running") {
      setHint(genMsg, "生成中，请稍候（约 30 秒～数分钟）…");
      return;
    }

    clearInterval(pollTimer);
    pollTimer = null;
    btnGenerate.disabled = false;

    if (job.status === "failed") {
      setHint(genMsg, job.error || "生成失败", "error");
      return;
    }

    if (job.status === "done" && job.images && job.images.length) {
      resultSection.classList.remove("hidden");
      resultImages.innerHTML = "";
      job.images.forEach((path, i) => {
        const url = apiUrl(path);
        const img = document.createElement("img");
        img.src = url;
        img.alt = "结果 " + (i + 1);
        img.className = "result-img";
        resultImages.appendChild(img);
        if (i === 0) lastResultUrl = url;
      });
      setHint(genMsg, "生成完成", "ok");
      setStatus("完成");
    }
  }

  async function startGenerate() {
    if (!fileId) {
      setHint(genMsg, "请先上传图片", "error");
      return;
    }
    const prompt = promptEl.value.trim();
    if (!prompt) {
      setHint(genMsg, "请填写编辑描述", "error");
      return;
    }

    localStorage.setItem(STORAGE_KEY, apiBaseInput.value.trim());
    btnGenerate.disabled = true;
    setHint(genMsg, "提交任务…");
    setStatus("提交中");
    resultSection.classList.add("hidden");
    lastResultUrl = null;

    const r = await fetch(apiUrl("/api/generate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId, prompt: prompt }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      btnGenerate.disabled = false;
      setHint(genMsg, data.detail || "提交失败", "error");
      return;
    }

    const jobId = data.job_id;
    setHint(genMsg, "任务已创建: " + jobId);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      pollJob(jobId).catch(function (e) {
        clearInterval(pollTimer);
        pollTimer = null;
        btnGenerate.disabled = false;
        setHint(genMsg, e.message, "error");
      });
    }, 2000);
    pollJob(jobId).catch(function (e) {
      setHint(genMsg, e.message, "error");
    });
  }

  btnPing.addEventListener("click", function () {
    ping().catch(function (e) {
      setHint(pingMsg, e.message, "error");
    });
  });

  apiBaseInput.addEventListener("input", updateApiWarn);

  fileInput.addEventListener("change", function () {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    uploadFile(file).catch(function (e) {
      setHint(uploadMsg, e.message, "error");
    });
  });

  btnGenerate.addEventListener("click", function () {
    startGenerate().catch(function (e) {
      btnGenerate.disabled = false;
      setHint(genMsg, e.message, "error");
    });
  });

  btnPrint.addEventListener("click", function () {
    printImage(lastResultUrl);
  });

  loadDefaultApiBase().then(function () {
    updateApiWarn();
    return ping();
  });
})();

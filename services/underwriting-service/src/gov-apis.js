"use strict";
/**
 * gov-apis.js
 * All 8 free Mexican government APIs used in underwriting.
 * No API keys. No authentication. Just plain HTTP calls.
 * All results cached in Redis for 24 hours to avoid hammering gov servers.
 */
const fetch  = require("node-fetch");
const redis  = require("./redis-client");

const CACHE_TTL = 86400; // 24 hours

// ── 1. SAT SOAP — CFDI invoice validation ────────────────────────────
async function checkCFDI({ uuid, emisorRfc, receptorRfc, total }) {
  const cacheKey = `cfdi:${uuid}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached);

  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ConsultaCFDI xmlns="http://tempuri.org/">
      <expresionImpresa>
        ?re=${emisorRfc}&amp;rr=${receptorRfc}&amp;tt=${total}&amp;id=${uuid}
      </expresionImpresa>
    </ConsultaCFDI>
  </soap:Body>
</soap:Envelope>`;

  const res = await fetch(process.env.SAT_SOAP_CFDI_URL, {
    method: "POST",
    headers: { "Content-Type": "text/xml", "SOAPAction": "" },
    body: soapBody,
    timeout: 10000,
  });
  const xml = await res.text();

  const estado = (xml.match(/<Estado>(.*?)<\/Estado>/) || [])[1] || "No Encontrado";
  const result = {
    estado,
    esCancelable: (xml.match(/<EsCancelable>(.*?)<\/EsCancelable>/) || [])[1] || null,
    pass: estado === "Vigente",
  };

  await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL);
  return result;
}

// ── 2. INEGI DENUE — business registry ───────────────────────────────
async function checkDENUE(companyName, stateCode) {
  const baseUrl = process.env.DENUE_API_URL;
  if (!baseUrl) throw new Error("DENUE_API_URL env var is not configured");

  const cacheKey = `denue:${companyName}:${stateCode}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached);

  const url = `${baseUrl}?keyword=${encodeURIComponent(companyName)}&entidad=${stateCode}&pageSize=5`;
  const res  = await fetch(url, { timeout: 10000 });
  const data = await res.json();

  const results = data.results || [];
  const result = {
    found:   results.length > 0,
    count:   results.length,
    topMatch: results[0] ? {
      nombre:     results[0].nombre,
      municipio:  results[0].municipio,
      sector:     results[0].codigo_actividad,
      fechaAlta:  results[0].fecha_alta,
    } : null,
    pass: results.length > 0,
  };

  await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL);
  return result;
}

// ── 3. STPS REPSE — subcontracting registration ───────────────────────
async function checkREPSE(rfc) {
  const baseUrl = process.env.REPSE_URL;
  if (!baseUrl) throw new Error("REPSE_URL env var is not configured");

  const cacheKey = `repse:${rfc}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached);

  const res  = await fetch(`${baseUrl}?rfc=${rfc}`, { timeout: 10000 });
  const data = await res.json().catch(() => ({ valido: false, vigente: false }));

  const result = {
    registrado:     !!data.valido,
    vigente:        !!data.vigente,
    fechaVigencia:  data.fechaVigencia || null,
    pass: data.valido && data.vigente,
  };

  await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL);
  return result;
}

// ── 4. ip-api.com — geolocation ───────────────────────────────────────
async function checkGeolocation(ipAddress) {
  if (!ipAddress || ipAddress === "127.0.0.1" || ipAddress === "::1") {
    return { skip: true, reason: "local_ip" };
  }

  const cacheKey = `geo:${ipAddress}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached);

  const res  = await fetch(`http://ip-api.com/json/${ipAddress}?fields=status,country,regionName,city,lat,lon,mobile,proxy,hosting`, { timeout: 5000 });
  const data = await res.json();

  const result = {
    country:    data.country,
    region:     data.regionName,
    city:       data.city,
    isMobile:   !!data.mobile,
    isProxy:    !!data.proxy,
    isHosting:  !!data.hosting,
    pass:       data.status === "success" && !data.proxy && !data.hosting,
  };

  await redis.set(cacheKey, JSON.stringify(result), "EX", 3600);
  return result;
}

// ── 5. SEP Cédulas Profesionales ─────────────────────────────────────
async function checkCedula(nombre, apellidoPaterno, apellidoMaterno) {
  const cacheKey = `cedula:${apellidoPaterno}:${apellidoMaterno}:${nombre}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached);

  try {
    const params = new URLSearchParams({
      nombre, paterno: apellidoPaterno, materno: apellidoMaterno || "",
      maxResult: "10", tipoBusqueda: "equivalente",
    });
    const res  = await fetch(`${process.env.SEP_CEDULAS_URL}?tipo=XML`, {
      method:  "POST", body: params, timeout: 12000,
    });
    const xml  = await res.text();
    const items = (xml.match(/<item>/g) || []).length;
    const result = { found: items > 0, count: items, pass: items > 0 };
    await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL * 7);
    return result;
  } catch (e) {
    return { found: null, error: e.message, pass: false, skipped: true };
  }
}

// ── 6. CNBV sector risk ───────────────────────────────────────────────
async function checkCNBVSector(db, scianSectorCode) {
  const twoDigit = String(scianSectorCode).substring(0, 2);
  const doc = await db.collection("cnbv_sector_risk").doc(twoDigit).get();
  if (!doc.exists) return { riskLevel: "unknown", pass: true };
  const { riskLevel } = doc.data();
  return {
    riskLevel,
    pass: riskLevel !== "alto",
    flag: riskLevel === "alto",
  };
}

// ── 7. REPUVE — vehicle registry ──────────────────────────────────────
async function checkREPUVE(placa) {
  const cacheKey = `repuve:${placa}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached);

  try {
    const res  = await fetch(`${process.env.REPUVE_URL}?placa=${encodeURIComponent(placa)}`, { timeout: 10000 });
    const data = await res.json().catch(() => ({}));
    const result = {
      found:     !!data.placa,
      reportado: !!data.reportado,
      pass:      !!data.placa && !data.reportado,
    };
    await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL);
    return result;
  } catch (e) {
    return { found: null, error: e.message, pass: false, skipped: true };
  }
}

// ── 8. CONDUSEF — complaints registry ────────────────────────────────
async function checkCONDUSEF(rfc) {
  const cacheKey = `condusef:${rfc}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached);

  try {
    const res  = await fetch(
      `${process.env.CONDUSEF_URL}?busqueda=${encodeURIComponent(rfc)}&tipo=empresa`,
      { timeout: 12000 }
    );
    const html = await res.text();
    const countMatch = html.match(/(\d+)\s+quejas?\s+registradas?/i);
    const count = countMatch ? parseInt(countMatch[1]) : 0;
    const result = {
      count,
      flag:   count > 10,
      reject: count > 50,
      pass:   count <= 10,
    };
    await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL);
    return result;
  } catch (e) {
    return { count: 0, error: e.message, pass: false, skipped: true };
  }
}

module.exports = {
  checkCFDI,
  checkDENUE,
  checkREPSE,
  checkGeolocation,
  checkCedula,
  checkCNBVSector,
  checkREPUVE,
  checkCONDUSEF,
};

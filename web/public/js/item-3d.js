/* Inspetor 3D de itens do MU para a Cash Shop.
   Le o .bmd (decifrando a versao 0x0C), as texturas .OZJ/.OZT e desenha o
   item num canvas com z-buffer, permitindo girar com o mouse.
   Portado do renderizador Python (bmd-icone.py) usado para gerar os icones. */
(function () {
  'use strict';

  var MAP_XOR_KEY = new Uint8Array([
    0xD1,0x73,0x52,0xF6,0xD2,0x9A,0xCB,0x27,0x3E,0xAF,0x59,0x31,0x37,0xB3,0xE7,0xA2]);

  function decryptFileCryptor(src) {
    var dst = new Uint8Array(src.length), k = 0x5E;
    for (var i = 0; i < src.length; i++) {
      dst[i] = ((src[i] ^ MAP_XOR_KEY[i & 15]) - k) & 0xFF;
      k = (src[i] + 0x3D) & 0xFF;
    }
    return dst;
  }

  function decifra(buf) {
    var raw = new Uint8Array(buf);
    if (raw[0] !== 0x42 || raw[1] !== 0x4D || raw[2] !== 0x44) throw new Error('nao e BMD');
    var ver = raw[3];
    if (ver !== 12 && ver !== 15) return raw;
    var size = new DataView(buf).getInt32(4, true);
    if (size < 0 || size > raw.length - 8) throw new Error('tamanho invalido');
    if (ver === 15) throw new Error('BMD versao 15 (LEA) nao suportado');
    var enc = raw.subarray(8, 8 + size);
    var dec = decryptFileCryptor(enc);
    var out = new Uint8Array(raw);
    out.set(dec, 8);
    return out;
  }

  /* ---------- parsing ---------- */
  function parseBmd(buf) {
    var d = decifra(buf);
    var dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    var off = (d[3] === 12 || d[3] === 15) ? 8 : 4;
    off += 32;                                     // nome do modelo
    var meshCount = dv.getUint16(off, true); off += 2;
    off += 4;                                      // boneCount, actionCount

    function str(o, n) {
      var s = '', c;
      for (var i = 0; i < n; i++) { c = d[o + i]; if (!c) break; s += String.fromCharCode(c); }
      return s;
    }
    var meshes = [];
    for (var m = 0; m < meshCount; m++) {
      var nv = dv.getInt16(off, true), nn = dv.getInt16(off + 2, true),
          nt = dv.getInt16(off + 4, true), ntri = dv.getInt16(off + 6, true);
      off += 10;
      var verts = new Float32Array(nv * 3);
      for (var v = 0; v < nv; v++) {
        verts[v * 3] = dv.getFloat32(off + v * 16 + 4, true);
        verts[v * 3 + 1] = dv.getFloat32(off + v * 16 + 8, true);
        verts[v * 3 + 2] = dv.getFloat32(off + v * 16 + 12, true);
      }
      off += nv * 16;
      var norms = new Float32Array(nn * 3);
      for (var n = 0; n < nn; n++) {
        norms[n * 3] = dv.getFloat32(off + n * 20 + 4, true);
        norms[n * 3 + 1] = dv.getFloat32(off + n * 20 + 8, true);
        norms[n * 3 + 2] = dv.getFloat32(off + n * 20 + 12, true);
      }
      off += nn * 20;
      var uvs = new Float32Array(nt * 2);
      for (var t = 0; t < nt; t++) {
        uvs[t * 2] = dv.getFloat32(off + t * 8, true);
        uvs[t * 2 + 1] = dv.getFloat32(off + t * 8 + 4, true);
      }
      off += nt * 8;
      var tris = new Int16Array(ntri * 13);         // poly + 3x4 indices
      for (var k = 0; k < ntri; k++) {
        var b = off + k * 64, o = k * 13;
        tris[o] = d[b];
        for (var j = 0; j < 4; j++) {
          tris[o + 1 + j] = dv.getInt16(b + 2 + j * 2, true);
          tris[o + 5 + j] = dv.getInt16(b + 10 + j * 2, true);
          tris[o + 9 + j] = dv.getInt16(b + 18 + j * 2, true);
        }
      }
      off += ntri * 64;
      var tex = str(off, 32); off += 32;
      meshes.push({ verts: verts, norms: norms, uvs: uvs, tris: tris,
                    ntri: ntri, tex: tex });
    }
    return meshes;
  }

  /* ---------- texturas ---------- */
  var OZJ_EXTS = ['.ozj', '.OZJ', '.jpg', '.JPG', '.ozt', '.OZT', '.tga', '.png'];

  function base(nome) { return nome.replace(/\.[^.]+$/, ''); }

  function pegaTex(nome, pastas) {
    var b = base(nome);
    var tentativas = [];
    pastas.forEach(function (p) {
      OZJ_EXTS.forEach(function (e) { tentativas.push(p + '/' + b + e); });
    });
    var i = 0;
    function proximo() {
      if (i >= tentativas.length) return Promise.resolve(null);
      var url = tentativas[i++];
      return fetch(url).then(function (r) {
        if (!r.ok) return proximo();
        return r.arrayBuffer();
      }).catch(proximo);
    }
    return proximo();
  }

  function jpegDaOZJ(buf) {
    var b = new Uint8Array(buf), ini = -1, fim = -1;
    for (var i = 0; i < b.length - 2; i++) {
      if (b[i] === 0xFF && b[i + 1] === 0xD8 && b[i + 2] === 0xFF) { ini = i; break; }
    }
    if (ini < 0) return null;
    for (var j = b.length - 2; j > ini; j--) {
      if (b[j] === 0xFF && b[j + 1] === 0xD9) { fim = j + 2; break; }
    }
    if (fim < 0) return null;
    return new Blob([b.slice(ini, fim)], { type: 'image/jpeg' });
  }

  function imagemDeBlob(blob) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); res(img); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('img')); };
      img.src = url;
    });
  }

  function texturaDeImagem(img) {
    var c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    var g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    var d = g.getImageData(0, 0, c.width, c.height).data;
    return { w: c.width, h: c.height, data: d };
  }

  /* ---------- render ---------- */
  function render(canvas, meshes, texs, angX, angY, margem) {
    margem = margem === undefined ? 0.06 : margem;
    var W = canvas.width, H = canvas.height;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(W, H);
    var buf = img.data;
    for (var i = 3; i < buf.length; i += 4) buf[i] = 0;    // transparente
    var zbuf = new Float32Array(W * H).fill(-1e18);

    var cx = Math.cos(angX), sx = Math.sin(angX);
    var cy = Math.cos(angY), sy = Math.sin(angY);

    // Eixo maior do modelo -> vertical da tela (igual ao renderizador Python).
    // Sem isso a espada aparece deitada.
    var b0 = [1e18, 1e18, 1e18], b1 = [-1e18, -1e18, -1e18];
    meshes.forEach(function (m) {
      for (var k = 0; k < m.verts.length; k += 3) {
        for (var a = 0; a < 3; a++) {
          var v = m.verts[k + a];
          if (v < b0[a]) b0[a] = v;
          if (v > b1[a]) b1[a] = v;
        }
      }
    });
    var t0 = b1[0] - b0[0], t1 = b1[1] - b0[1], t2 = b1[2] - b0[2];
    var eixo = (t0 >= t1 && t0 >= t2) ? 0 : (t1 >= t2 ? 1 : 2);

    function base(x, y, z) {
      if (eixo === 0) return [-y, x, z];    // lamina em X -> Y
      if (eixo === 2) return [x, z, -y];    // lamina em Z -> Y
      return [x, y, z];
    }

    function vista(x, y, z) {
      var b = base(x, y, z);
      x = b[0]; y = b[1]; z = b[2];
      // gira em Y depois em X (igual ao renderizador Python)
      var x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
      var y1 = y * cx - z1 * sx, z2 = y * sx + z1 * cx;
      return [x1, y1, z2];
    }

    // caixa do modelo todo (nos eixos de tela)
    var mnx = 1e18, mxx = -1e18, mny = 1e18, mxy = -1e18;
    var transf = meshes.map(function (m) {
      var v = new Float32Array(m.verts.length);
      for (var k = 0; k < m.verts.length; k += 3) {
        var p = vista(m.verts[k], m.verts[k + 1], m.verts[k + 2]);
        v[k] = p[0]; v[k + 1] = p[1]; v[k + 2] = p[2];
        if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0];
        if (p[1] < mny) mny = p[1]; if (p[1] > mxy) mxy = p[1];
      }
      var nrm = new Float32Array(m.norms.length);
      for (var q = 0; q < m.norms.length; q += 3) {
        var n = vista(m.norms[q], m.norms[q + 1], m.norms[q + 2]);
        nrm[q] = n[0]; nrm[q + 1] = n[1]; nrm[q + 2] = n[2];
      }
      return { verts: v, norms: nrm, uvs: m.uvs, tris: m.tris,
               ntri: m.ntri, tex: m.tex };
    });

    var larg = Math.max(1e-6, mxx - mnx), alt = Math.max(1e-6, mxy - mny);
    var esc = (Math.min(W, H) * (1 - 2 * margem)) / Math.max(larg, alt);
    var ox = W / 2 - (mnx + mxx) / 2 * esc;
    var oy = H / 2 + (mny + mxy) / 2 * esc;

    var luz = [0.35, 0.45, 0.82];
    var nl = Math.sqrt(luz[0] * luz[0] + luz[1] * luz[1] + luz[2] * luz[2]);
    luz = [luz[0] / nl, luz[1] / nl, luz[2] / nl];

    function tri(pa, pb, pc, ta, tb, tc, na, nb, nc, tex) {
      var cor = 0.42 + 0.58 * Math.abs(
        ((na[0] + nb[0] + nc[0]) / 3) * luz[0] +
        ((na[1] + nb[1] + nc[1]) / 3) * luz[1] +
        ((na[2] + nb[2] + nc[2]) / 3) * luz[2]);
      var minx = Math.max(0, Math.floor(Math.min(pa[0], pb[0], pc[0])));
      var maxx = Math.min(W - 1, Math.ceil(Math.max(pa[0], pb[0], pc[0])));
      var miny = Math.max(0, Math.floor(Math.min(pa[1], pb[1], pc[1])));
      var maxy = Math.min(H - 1, Math.ceil(Math.max(pa[1], pb[1], pc[1])));
      var det = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pb[1] - pa[1]);
      if (Math.abs(det) < 1e-9) return;
      for (var y = miny; y <= maxy; y++) {
        for (var x = minx; x <= maxx; x++) {
          var w0 = ((pb[0] - pa[0]) * (y + .5 - pa[1]) - (x + .5 - pa[0]) * (pb[1] - pa[1])) / det;
          if (w0 < 0) continue;
          var w1 = ((x + .5 - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (y + .5 - pa[1])) / det;
          if (w1 < 0) continue;
          var w2 = 1 - w0 - w1;
          if (w2 < 0) continue;
          var z = w2 * pa[2] + w1 * pb[2] + w0 * pc[2];
          var off = y * W + x;
          if (z <= zbuf[off]) continue;
          zbuf[off] = z;
          var r, g, b;
          if (tex) {
            var u = w2 * ta[0] + w1 * tb[0] + w0 * tc[0];
            var vv = w2 * ta[1] + w1 * tb[1] + w0 * tc[1];
            u = u - Math.floor(u); vv = vv - Math.floor(vv);
            var tx = (u * (tex.w - 1)) | 0, ty = (vv * (tex.h - 1)) | 0;
            var ti = (ty * tex.w + tx) * 4;
            r = tex.data[ti]; g = tex.data[ti + 1]; b = tex.data[ti + 2];
          } else { r = g = b = 190; }
          var p4 = off * 4;
          buf[p4] = Math.min(255, r * cor);
          buf[p4 + 1] = Math.min(255, g * cor);
          buf[p4 + 2] = Math.min(255, b * cor);
          buf[p4 + 3] = 255;
        }
      }
    }

    var L = [0.35, 0.45, 0.82];
    transf.forEach(function (m) {
      var tex = texs[m.tex] || null;
      for (var k = 0; k < m.ntri; k++) {
        var o = k * 13, poly = m.tris[o];
        var n = poly === 4 ? 4 : 3;
        var pa, pb, pc;
        function pt(i) {
          var vi = m.tris[o + 1 + i] * 3, ni = m.tris[o + 5 + i] * 3, ti = m.tris[o + 9 + i] * 2;
          if (vi < 0 || vi + 2 >= m.verts.length) return null;
          return {
            p: [m.verts[vi] * esc + ox, oy - m.verts[vi + 1] * esc, m.verts[vi + 2]],
            n: [m.norms[ni] || 0, m.norms[ni + 1] || 0, m.norms[ni + 2] || 0],
            t: [m.uvs[ti] || 0, m.uvs[ti + 1] || 0]
          };
        }
        var a = pt(0), b = pt(1), c = pt(2), dd = n === 4 ? pt(3) : null;
        if (a && b && c) tri(a.p, b.p, c.p, a.t, b.t, c.t, a.n, b.n, c.n, tex);
        if (dd && a && c) tri(a.p, c.p, dd.p, a.t, c.t, dd.t, a.n, c.n, dd.n, tex);
      }
    });
    ctx.putImageData(img, 0, 0);
  }

  /* ---------- API publica ---------- */
  var cache = {};

  window.MUItem3D = {
    abrir: function (secao, indice, nome) {
      var mapa = window.MU_ITEM_MODELS || {};
      var info = mapa[secao + ',' + indice];
      var modal = document.getElementById('mu3d');
      var titulo = document.getElementById('mu3d-nome');
      var canvas = document.getElementById('mu3d-canvas');
      var status = document.getElementById('mu3d-status');
      titulo.textContent = nome || ('Item ' + secao + ',' + indice);
      modal.classList.add('aberto');
      status.textContent = 'Carregando modelo...';
      canvas.width = 420; canvas.height = 420;

      if (!info) { status.textContent = 'Este item não tem modelo 3D disponível.'; return; }

      var chave = secao + ',' + indice;
      var pasta = '/updates/Data/' + info.dir + '/';
      var pastas = [pasta, '/updates/Data/Item', '/updates/Data/Player'];

      function pronto(meshes, texs) {
        var angX = -0.16, angY = 0.0;
        var arrastando = false, lx = 0;
        function desenha() { render(canvas, meshes, texs, angX, angY); }
        desenha();
        status.textContent = 'Arraste para girar';
        canvas.onmousedown = function (e) { arrastando = true; lx = e.clientX; };
        window.onmouseup = function () { arrastando = false; };
        canvas.onmousemove = function (e) {
          if (!arrastando) return;
          angY += (e.clientX - lx) * 0.012; lx = e.clientX;
          desenha();
        };
        canvas.ontouchmove = function (e) {
          if (e.touches.length) {
            angY += (e.touches[0].clientX - lx) * 0.012; lx = e.touches[0].clientX;
            desenha(); e.preventDefault();
          }
        };
        canvas.ontouchstart = function (e) { if (e.touches.length) lx = e.touches[0].clientX; };
      }

      if (cache[chave]) { pronto(cache[chave][0], cache[chave][1]); return; }

      fetch(pasta + info.file).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (b) {
        var meshes = parseBmd(b);
        // tira malhas de EFEITO (chama, brilho): viram um retangulo solto
        var EFEITO = ['fire', 'flame', 'glow', 'light', 'effe', 'smoke',
                      'spark', 'flash', 'flare', 'trail', 'fogo', 'chama'];
        if (meshes.length > 1) {
          var limpos = meshes.filter(function (m) {
            var t = (m.tex || '').toLowerCase();
            for (var i = 0; i < EFEITO.length; i++) if (t.indexOf(EFEITO[i]) >= 0) return false;
            return true;
          });
          if (limpos.length) meshes = limpos;
        }
        // junta as texturas necessarias
        var nomes = [];
        meshes.forEach(function (m) { if (m.tex && nomes.indexOf(m.tex) < 0) nomes.push(m.tex); });
        return Promise.all(nomes.map(function (t) {
          return pegaTex(t, pastas).then(function (buf) {
            if (!buf) return null;
            var jpg = jpegDaOZJ(buf);
            var b2 = jpg || new Blob([buf]);
            return imagemDeBlob(b2).then(texturaDeImagem).catch(function () { return null; });
          });
        })).then(function (texs) {
          var mapaTex = {};
          nomes.forEach(function (t, i) { if (texs[i]) mapaTex[t] = texs[i]; });
          cache[chave] = [meshes, mapaTex];
          pronto(meshes, mapaTex);
        });
      }).catch(function (e) {
        status.textContent = 'Não foi possível carregar o modelo (' + e.message + ').';
      });
    },
    fechar: function () {
      document.getElementById('mu3d').classList.remove('aberto');
    }
  };
})();

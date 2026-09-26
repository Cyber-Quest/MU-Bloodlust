/* Inspetor 3D de itens do MU (Cash Shop).
   Usa Three.js para renderizar o modelo .bmd com UV/iluminacao corretos.
   - decifra o .bmd (versao 0x0C) e monta a geometria
   - orienta a ponta da arma para cima (tip) ou usa o eixo dominante
   - texturas ja vem resolvidas do servidor (item-models.js) */
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
    var out = new Uint8Array(raw);
    out.set(decryptFileCryptor(raw.subarray(8, 8 + size)), 8);
    return out;
  }

  function parseBmd(buf) {
    var d = decifra(buf);
    var dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    var off = (d[3] === 12 || d[3] === 15) ? 8 : 4;
    off += 32;
    var meshCount = dv.getUint16(off, true); off += 2;
    off += 4; // boneCount, actionCount

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
      var tris = new Int16Array(ntri * 13);
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

  /* ---------- textura: pega o maior jpeg embutido no .OZJ ---------- */
  function melhoresJpegs(buf) {
    var b = new Uint8Array(buf), sois = [];
    for (var i = 0; i < b.length - 2; i++) {
      if (b[i] === 0xFF && b[i + 1] === 0xD8 && b[i + 2] === 0xFF) sois.push(i);
    }
    var cands = sois.map(function (s) {
      for (var j = s + 2; j < b.length - 1; j++) {
        if (b[j] === 0xFF && b[j + 1] === 0xD9) return b.slice(s, j + 2);
      }
      return null;
    }).filter(Boolean);
    if (!cands.length) cands.push(b);
    cands.sort(function (x, y) { return y.length - x.length; });
    return cands;
  }

  function imagemParaTextura(buf) {
    return new Promise(function (resolve) {
      var cands = melhoresJpegs(buf);
      var i = 0;
      function prox() {
        if (i >= cands.length) { resolve(null); return; }
        var blob = new Blob([cands[i++]], { type: 'image/jpeg' });
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function () {
          URL.revokeObjectURL(url);
          var tex = new THREE.Texture(img);
          tex.needsUpdate = true;
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.flipY = false; // UV do MU sao "v=0 no topo" (igual ao jogo/DirectX)
          resolve(tex);
        };
        img.onerror = function () { URL.revokeObjectURL(url); prox(); };
        img.src = url;
      }
      prox();
    });
  }

  /* ---------- orientacao (ponta para cima) ---------- */
  function fazBase(secao, tipCode, meshes) {
    // extensao do modelo nos 3 eixos
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
    var e = [b1[0] - b0[0], b1[1] - b0[1], b1[2] - b0[2]];

    // ESCUDO (6): a face fina -> camera (Z) e o eixo maior -> cima (Y).
    // O escudo e' chato, entao o eixo mais fino e' sempre a normal da face.
    if (secao === 6) {
      var thin = (e[0] <= e[1] && e[0] <= e[2]) ? 0 : (e[1] <= e[2] ? 1 : 2);
      var long = (e[0] >= e[1] && e[0] >= e[2]) ? 0 : (e[1] >= e[2] ? 1 : 2);
      var mid = 3 - thin - long;
      var perm = [mid, long, thin]; // perm[alvo] = eixo de origem
      var signs = [1, 1, 1];
      var inv = 0, i, j;
      for (i = 0; i < 3; i++) for (j = i + 1; j < 3; j++) if (perm[i] > perm[j]) inv++;
      if (inv % 2 === 1) signs[2] = -1; // mantem det=+1 (rotacao pura, sem espelho)
      return function (x, y, z) {
        var v = [x, y, z];
        return [signs[0] * v[perm[0]], signs[1] * v[perm[1]], signs[2] * v[perm[2]]];
      };
    }

    // ARMADURAS / PECAS (7-11): o esqueleto Bip01 guarda o corpo DEITADO
    // (cabeca no +X). Gira para o +X virar +Y (cima); o yaw depois cuida da frente.
    if (secao >= 7 && secao <= 11) {
      return function (x, y, z) { return [-y, x, z]; };
    }

    // ARMAS (0-5): ponta para cima
    if (secao <= 5) {
      var eixo = 1;
      if (!tipCode) {
        eixo = (e[0] >= e[1] && e[0] >= e[2]) ? 0 : (e[1] >= e[2] ? 1 : 2);
      }
      return function (x, y, z) {
        if (tipCode === 'nx') return [y, -x, z];
        if (tipCode === 'ny') return [-x, -y, z];
        if (tipCode === 'pz') return [x, z, -y];
        if (eixo === 0) return [-y, x, z];
        if (eixo === 2) return [x, z, -y];
        return [x, y, z];
      };
    }

    // DEMAIS (asas 12, pets/pocoes 13-15): deixa como esta
    return function (x, y, z) { return [x, y, z]; };
  }

  /* ---------- tira malhas de efeito (chama/brilho), que viram retangulo solto ---------- */
  var EFEITO = /fire|flame|glow|light|effe|smoke|spark|flash|flare|trail|fogo|chama/i;
  function filtraEfeito(meshes) {
    if (meshes.length <= 1) return meshes;
    var limpos = meshes.filter(function (m) { return !EFEITO.test(m.tex); });
    return limpos.length ? limpos : meshes;
  }

  /* ---------- estado ---------- */
  var st = null;

  function monta(canvas, meshes, texs, secao, tipCode) {
    if (st) {
      st.renderer.dispose();
      st = null;
    }
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.setSize(420, 420, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, 0, 3.4);

    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    var dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(0.7, 1.0, 1.6);
    scene.add(dir);
    var dir2 = new THREE.DirectionalLight(0xffffff, 0.35);
    dir2.position.set(-0.8, -0.3, -1.0);
    scene.add(dir2);

    var base = fazBase(secao, tipCode, meshes);

    // 1a passada: extensao apos a rotacao base, para achar a "frente".
    // Se a maior dimensao horizontal cair na profundidade (Z), o item esta
    // de lado -> gira 90 graus em torno de Y para a frente encarar a camera.
    var mn = [1e18, 1e18, 1e18], mx = [-1e18, -1e18, -1e18];
    meshes.forEach(function (mesh) {
      for (var k = 0; k < mesh.verts.length; k += 3) {
        var q = base(mesh.verts[k], mesh.verts[k + 1], mesh.verts[k + 2]);
        for (var a = 0; a < 3; a++) {
          if (q[a] < mn[a]) mn[a] = q[a];
          if (q[a] > mx[a]) mx[a] = q[a];
        }
      }
    });
    var yaw = (mx[2] - mn[2]) > (mx[0] - mn[0]);
    function orient(x, y, z) {
      var q = base(x, y, z);
      return yaw ? [q[2], q[1], -q[0]] : q;
    }

    // monta geometria (rotacionada), junta tudo num grupo e calcula a caixa
    var grupo = new THREE.Group();
    var min = [1e18, 1e18, 1e18], max = [-1e18, -1e18, -1e18];

    meshes.forEach(function (mesh) {
      var pos = [], norm = [], uv = [];
      for (var t = 0; t < mesh.ntri; t++) {
        var o = t * 13, poly = mesh.tris[o];
        var corners = poly === 4 ? [0, 1, 2, 0, 2, 3] : [0, 1, 2];
        for (var j = 0; j < corners.length; j++) {
          var c = corners[j];
          var vi = mesh.tris[o + 1 + c], ni = mesh.tris[o + 5 + c], ti = mesh.tris[o + 9 + c];
          if (vi < 0 || vi * 3 + 2 >= mesh.verts.length) continue;
          var p = orient(mesh.verts[vi * 3], mesh.verts[vi * 3 + 1], mesh.verts[vi * 3 + 2]);
          pos.push(p[0], p[1], p[2]);
          if (p[0] < min[0]) min[0] = p[0]; if (p[0] > max[0]) max[0] = p[0];
          if (p[1] < min[1]) min[1] = p[1]; if (p[1] > max[1]) max[1] = p[1];
          if (p[2] < min[2]) min[2] = p[2]; if (p[2] > max[2]) max[2] = p[2];
          if (ni >= 0 && ni * 3 + 2 < mesh.norms.length) {
            var n = orient(mesh.norms[ni * 3], mesh.norms[ni * 3 + 1], mesh.norms[ni * 3 + 2]);
            norm.push(n[0], n[1], n[2]);
          } else {
            norm.push(0, 1, 0);
          }
          if (ti >= 0 && ti * 2 + 1 < mesh.uvs.length) {
            uv.push(mesh.uvs[ti * 2], mesh.uvs[ti * 2 + 1]);
          } else {
            uv.push(0, 0);
          }
        }
      }
      if (!pos.length) return;
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      var mat = new THREE.MeshStandardMaterial({
        map: texs[mesh.tex] || null,
        roughness: 0.55, metalness: 0.15, side: THREE.DoubleSide
      });
      grupo.add(new THREE.Mesh(g, mat));
    });

    // centraliza e escala para caber na camera
    var centro = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    var tam = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-6);
    var escala = 2.1 / tam;
    grupo.position.set(-centro[0] * escala, -centro[1] * escala, -centro[2] * escala);
    grupo.scale.set(escala, escala, escala);

    scene.add(grupo);
    grupo.rotation.order = 'YXZ';
    st = { renderer: renderer, scene: scene, camera: camera, grupo: grupo,
           angX: 0.12, angY: 0.5 };

    function desenha() {
      grupo.rotation.x = -st.angX;
      grupo.rotation.y = st.angY;
      renderer.render(scene, camera);
    }
    desenha();

    // arrastar para girar
    var arrastando = false, lx = 0, ly = 0;
    canvas.onmousedown = function (e) { arrastando = true; lx = e.clientX; ly = e.clientY; };
    window.addEventListener('mouseup', function () { arrastando = false; });
    canvas.onmousemove = function (e) {
      if (!arrastando) return;
      st.angY += (e.clientX - lx) * 0.012; lx = e.clientX;
      st.angX += (e.clientY - ly) * 0.012; ly = e.clientY;
      st.angX = Math.max(-1.2, Math.min(1.2, st.angX));
      desenha();
    };
    canvas.ontouchstart = function (e) {
      if (e.touches.length) { lx = e.touches[0].clientX; ly = e.touches[0].clientY; }
    };
    canvas.ontouchmove = function (e) {
      if (e.touches.length) {
        st.angY += (e.touches[0].clientX - lx) * 0.012; lx = e.touches[0].clientX;
        st.angX += (e.touches[0].clientY - ly) * 0.012; ly = e.touches[0].clientY;
        st.angX = Math.max(-1.2, Math.min(1.2, st.angX));
        desenha(); e.preventDefault();
      }
    };
  }

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

      if (!info) { status.textContent = 'Este item não tem modelo 3D disponível.'; return; }

      var chave = secao + ',' + indice;
      var secaoN = Number(secao);
      var tipCode = info.tip || null;

      function pronto(meshes, texs) {
        monta(canvas, meshes, texs, secaoN, tipCode);
        status.textContent = 'Arraste para girar';
      }

      if (cache[chave]) { pronto(cache[chave][0], cache[chave][1]); return; }

      fetch('/updates/Data/' + info.dir + '/' + info.file).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (b) {
        var meshes = filtraEfeito(parseBmd(b));
        var nomes = [];
        meshes.forEach(function (m) { if (m.tex && nomes.indexOf(m.tex) < 0) nomes.push(m.tex); });
        var texs = {};
        return Promise.all(nomes.map(function (t) {
          var direto = (info.tex && info.tex[t]) ? info.tex[t] : null;
          function carrega(buf) { return buf ? imagemParaTextura(buf) : null; }
          if (direto) {
            return fetch('/updates/' + direto).then(function (r) {
              return r.ok ? r.arrayBuffer() : null;
            }).catch(function () { return null; }).then(carrega);
          }
          return fetch('/updates/Data/' + info.dir + '/' + t).then(function (r) {
            return r.ok ? r.arrayBuffer() : null;
          }).catch(function () { return null; }).then(carrega);
        })).then(function (lista) {
          nomes.forEach(function (t, i) { if (lista[i]) texs[t] = lista[i]; });
          cache[chave] = [meshes, texs];
          pronto(meshes, texs);
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

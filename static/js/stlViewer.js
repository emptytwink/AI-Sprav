// static/js/stlViewer.js
(() => {

  function createMat4() {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  }

  function mat4Multiply(a, b) {
    const out = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        out[i * 4 + j] =
          a[i * 4 + 0] * b[0 * 4 + j] +
          a[i * 4 + 1] * b[1 * 4 + j] +
          a[i * 4 + 2] * b[2 * 4 + j] +
          a[i * 4 + 3] * b[3 * 4 + j];
      }
    }
    return out;
  }

  function mat4Perspective(fov, aspect, near, far) {
    const f = 1.0 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    const out = new Float32Array(16);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[14] = (2 * far * near) * nf;
    return out;
  }

  function mat4Translate(tx, ty, tz) {
    const out = createMat4();
    out[12] = tx;
    out[13] = ty;
    out[14] = tz;
    return out;
  }

  function mat4RotateX(a) {
    const c = Math.cos(a), s = Math.sin(a);
    const out = createMat4();
    out[5] = c; out[6] = s;
    out[9] = -s; out[10] = c;
    return out;
  }

  function mat4RotateY(a) {
    const c = Math.cos(a), s = Math.sin(a);
    const out = createMat4();
    out[0] = c; out[2] = -s;
    out[8] = s; out[10] = c;
    return out;
  }

  function parseSTL(arrayBuffer) {
    const isBinary = (buffer) => {
      if (buffer.byteLength < 84) return true;
      const header = new Uint8Array(buffer, 0, 80);
      const headerStr = String.fromCharCode.apply(null, header).trim();
      if (headerStr.toLowerCase().startsWith("solid")) {
        const tail = new Uint8Array(buffer, buffer.byteLength - 80, 80);
        const tailStr = String.fromCharCode.apply(null, tail).trim();
        if (tailStr.toLowerCase().startsWith("endsolid")) return false;
      }
      const dv = new DataView(buffer);
      const numFaces = dv.getUint32(80, true);
      const expected = 84 + numFaces * 50;
      return expected === buffer.byteLength;
    };

    if (isBinary(arrayBuffer)) {
      const dv = new DataView(arrayBuffer);
      const faces = dv.getUint32(80, true);
      const vertices = new Float32Array(faces * 9);
      let offset = 84;
      let vIndex = 0;
      for (let i = 0; i < faces; i++) {
        offset += 12; // normal
        for (let v = 0; v < 3; v++) {
          vertices[vIndex++] = dv.getFloat32(offset, true);
          vertices[vIndex++] = dv.getFloat32(offset + 4, true);
          vertices[vIndex++] = dv.getFloat32(offset + 8, true);
          offset += 12;
        }
        offset += 2; // attr
      }
      return vertices;
    } else {
      const text = new TextDecoder().decode(arrayBuffer);
      const lines = text.split("\n");
      const verts = [];
      for (let line of lines) {
        line = line.trim();
        if (line.toLowerCase().startsWith("vertex")) {
          const parts = line.split(/\s+/);
          verts.push(
            parseFloat(parts[1]),
            parseFloat(parts[2]),
            parseFloat(parts[3])
          );
        }
      }
      return new Float32Array(verts);
    }
  }

  class SimpleSTLViewer {
    constructor() {
      this.gl = null;
      this.program = null;
      this.buffers = null;
      this.vertexCount = 0;
      this.rotationX = 0;
      this.rotationY = 0;
      this.distance = 3;
      this.animating = false;
      this.canvas = null;

      this._onResize = this._onResize.bind(this);
      this._render = this._render.bind(this);
    }

    _initGL(container) {
      if (this.gl) return true;

      this.canvas = document.createElement("canvas");
      this.canvas.style.width = "100%";
      this.canvas.style.height = "100%";
      container.appendChild(this.canvas);

      const gl = this.canvas.getContext("webgl", { antialias: true });
      if (!gl) {
        container.innerHTML = `<div class="doc-error">Ваш браузер не поддерживает WebGL</div>`;
        return false;
      }

      this.gl = gl;

      const vsSource = `
        attribute vec3 aPosition;
        uniform mat4 uMVP;
        void main() {
          gl_Position = uMVP * vec4(aPosition, 1.0);
        }
      `;
      const fsSource = `
        precision mediump float;
        void main() {
          gl_FragColor = vec4(0.13, 0.58, 0.82, 1.0);
        }
      `;

      const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          console.error(gl.getShaderInfoLog(shader));
          gl.deleteShader(shader);
          return null;
        }
        return shader;
      };

      const vs = compile(gl.VERTEX_SHADER, vsSource);
      const fs = compile(gl.FRAGMENT_SHADER, fsSource);
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(program));
        return false;
      }
      gl.useProgram(program);

      this.program = {
        program,
        attribPosition: gl.getAttribLocation(program, "aPosition"),
        uniformMVP: gl.getUniformLocation(program, "uMVP")
      };

      this.buffers = {
        vertex: gl.createBuffer()
      };

      gl.enable(gl.DEPTH_TEST);
      gl.clearColor(0.96, 0.98, 1.0, 1.0);

      this._bindControls(container);
      window.addEventListener("resize", this._onResize);
      this._onResize();

      if (!this.animating) {
        this.animating = true;
        requestAnimationFrame(this._render);
      }

      return true;
    }

    _bindControls(container) {
      let dragging = false;
      let lastX = 0;
      let lastY = 0;

      container.addEventListener("pointerdown", (e) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        container.setPointerCapture(e.pointerId);
      });

      container.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        this.rotationY += dx * 0.01;
        this.rotationX += dy * 0.01;
      });

      container.addEventListener("pointerup", (e) => {
        dragging = false;
        try { container.releasePointerCapture(e.pointerId); } catch {}
      });

      container.addEventListener("wheel", (e) => {
        e.preventDefault();
        this.distance += e.deltaY * 0.001;
        if (this.distance < 1.5) this.distance = 1.5;
        if (this.distance > 10) this.distance = 10;
      }, { passive: false });
    }

    _onResize() {
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      this.canvas.width = rect.width || 400;
      this.canvas.height = rect.height || 300;
    }

    _render() {
      if (!this.animating || !this.gl || !this.program) return;

      const gl = this.gl;
      const w = this.canvas.width;
      const h = this.canvas.height;

      gl.viewport(0, 0, w, h);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      if (this.vertexCount > 0) {
        const aspect = w / h;
        const proj = mat4Perspective(Math.PI / 4, aspect, 0.1, 100);
        const view = mat4Translate(0, 0, -this.distance);
        const rotX = mat4RotateX(this.rotationX);
        const rotY = mat4RotateY(this.rotationY);
        const model = mat4Multiply(rotY, rotX);
        const vp = mat4Multiply(proj, view);
        const mvp = mat4Multiply(vp, model);

        gl.useProgram(this.program.program);
        gl.uniformMatrix4fv(this.program.uniformMVP, false, mvp);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.vertex);
        gl.enableVertexAttribArray(this.program.attribPosition);
        gl.vertexAttribPointer(this.program.attribPosition, 3, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
      }

      requestAnimationFrame(this._render);
    }

    clear() {
      if (this.canvas) {
        this.canvas.getContext && this.canvas.getContext("webgl")?.clear &&
          this.canvas.getContext("webgl").clear(0);
        this.canvas.innerHTML = "";
      }
    }

    async show(url, name) {
      const container = document.getElementById("doc-preview");
      if (!container) return;

      container.classList.remove("hidden");
      container.innerHTML = "";

      if (!this._initGL(container)) return;

      container.appendChild(this.canvas);

      let arrayBuffer;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("HTTP " + res.status);
        arrayBuffer = await res.arrayBuffer();
      } catch (e) {
        console.error("Ошибка загрузки STL:", e);
        container.innerHTML = `<div class="doc-error">
          Не удалось загрузить STL. Попробуйте скачать файл и открыть во внешней программе.
        </div>`;
        return;
      }

      const vertices = parseSTL(arrayBuffer);
      if (!vertices || !vertices.length) {
        container.innerHTML = `<div class="doc-error">
          Не удалось прочитать вершины STL-файла.
        </div>`;
        return;
      }

      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.vertex);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
      this.vertexCount = vertices.length / 3;

      // немного нормализуем масштаб
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < vertices.length; i += 3) {
        const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      const sizeX = maxX - minX || 1;
      const sizeY = maxY - minY || 1;
      const sizeZ = maxZ - minZ || 1;
      const maxSize = Math.max(sizeX, sizeY, sizeZ);
      this.distance = 2.5 * (maxSize || 1);

      this.rotationX = 0.6;
      this.rotationY = 0.8;
    }
  }

  window.STLViewer = new SimpleSTLViewer();

})();

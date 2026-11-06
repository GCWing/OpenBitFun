const VERTEX_SOURCE = `#version 300 es
uniform vec2 textureScale;
out vec2 uv;
void main() {
  const vec2 corners[3] = vec2[3](vec2(-1, -1), vec2(3, -1), vec2(-1, 3));
  vec2 position = corners[gl_VertexID];
  uv = (position * vec2(0.5, -0.5) + 0.5) * textureScale;
  gl_Position = vec4(position, 0, 1);
}`;

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
uniform sampler2D frame;
in vec2 uv;
out vec4 color;
void main() {
  color = texture(frame, uv).bgra;
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Could not allocate offscreen browser shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

export function createOffscreenGpu(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, failIfMajorPerformanceCaveat: true });
  if (!gl) return;

  const program = gl.createProgram();
  const texture = gl.createTexture();
  const dispose = () => {
    gl.useProgram(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteTexture(texture);
    gl.deleteProgram(program);
  };
  if (!program || !texture) {
    dispose();
    throw new Error('Could not allocate offscreen browser GPU resources');
  }
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SOURCE], [gl.FRAGMENT_SHADER, FRAGMENT_SOURCE]] as const) {
      const shader = compileShader(gl, type, source);
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Could not link offscreen browser shaders: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  } catch (error) {
    dispose();
    throw error;
  }

  const textureScale = gl.getUniformLocation(program, 'textureScale');
  const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  let textureWidth = 0;
  let textureHeight = 0;
  const capacity = (size: number, allocated: number) => size > allocated || size * 2 < allocated
    ? Math.min(maxSize, Math.ceil(size / 256) * 256) : allocated;

  return {
    dispose,
    draw(width: number, height: number, x: number, y: number, patchWidth: number, patchHeight: number, pixels: Uint8Array) {
      if (width > maxSize || height > maxSize || gl.isContextLost()) {
        throw new Error('Offscreen browser GPU backing store is unavailable');
      }
      const nextWidth = capacity(width, textureWidth);
      const nextHeight = capacity(height, textureHeight);
      if (nextWidth !== textureWidth || nextHeight !== textureHeight) {
        // Intermediate widths usually fit in the same backing store during a drag.
        // A change to the source dimensions always comes with a full frame.
        if (canvas.width !== nextWidth) canvas.width = nextWidth;
        if (canvas.height !== nextHeight) canvas.height = nextHeight;
        if (gl.drawingBufferWidth !== nextWidth || gl.drawingBufferHeight !== nextHeight) {
          throw new Error('Offscreen browser GPU backing store is unavailable');
        }
        textureWidth = nextWidth;
        textureHeight = nextHeight;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, textureWidth, textureHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        if (gl.getError() !== gl.NO_ERROR) throw new Error('Could not allocate offscreen browser GPU texture');
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, patchWidth, patchHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.viewport(0, textureHeight - height, width, height);
      gl.uniform2f(textureScale, width / textureWidth, height / textureHeight);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

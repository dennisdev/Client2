import World3D from '../../dash3d/World3D';
import PixMap from '../../graphics/PixMap';
import {Renderer} from '../Renderer';
import {Shader} from './Shader';
import {createProgram, ShaderProgram} from './ShaderProgram';
import {SHADER_CODE as pixMapFragShaderCode} from './shaders/fullscreen-pixmap.frag.glsl';
import {SHADER_CODE as pixMapVertShaderCode} from './shaders/fullscreen-pixmap.vert.glsl';
import {SHADER_CODE as textureFragShaderCode} from './shaders/fullscreen-texture.frag.glsl';
import {SHADER_CODE as textureVertShaderCode} from './shaders/fullscreen-texture.vert.glsl';
import {SHADER_CODE as mainFragShaderCode} from './shaders/main.frag.glsl';
import {SHADER_CODE as mainVertShaderCode} from './shaders/main.vert.glsl';

export class RendererWebGL extends Renderer {
    pixMapProgram!: ShaderProgram;
    textureProgram!: ShaderProgram;
    mainProgram!: ShaderProgram;

    viewportFramebuffer!: WebGLFramebuffer;
    viewportColorTarget!: WebGLTexture;

    texturesToDelete: WebGLTexture[] = [];

    isRenderingScene: boolean = false;

    static init(container: HTMLElement, width: number, height: number): RendererWebGL {
        const canvas: HTMLCanvasElement = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.style.display = 'block';
        canvas.style.position = 'absolute';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        container.appendChild(canvas);

        const gl: WebGL2RenderingContext | null = canvas.getContext('webgl2', {
            preserveDrawingBuffer: true
        });
        if (!gl) {
            canvas.remove();
            throw new Error('WebGL2 is not supported');
        }

        return new RendererWebGL(canvas, gl);
    }

    constructor(
        canvas: HTMLCanvasElement,
        readonly gl: WebGL2RenderingContext
    ) {
        super(canvas);
        this.init();
    }

    init(): void {
        this.gl.enable(this.gl.CULL_FACE);

        const pixMapVertShader: Shader = new Shader(this.gl, this.gl.VERTEX_SHADER, pixMapVertShaderCode);
        const pixMapFragShader: Shader = new Shader(this.gl, this.gl.FRAGMENT_SHADER, pixMapFragShaderCode);
        this.pixMapProgram = createProgram(this.gl, [pixMapVertShader, pixMapFragShader]);
        const textureVertShader: Shader = new Shader(this.gl, this.gl.VERTEX_SHADER, textureVertShaderCode);
        const textureFragShader: Shader = new Shader(this.gl, this.gl.FRAGMENT_SHADER, textureFragShaderCode);
        this.textureProgram = createProgram(this.gl, [textureVertShader, textureFragShader]);
        const mainVertShader: Shader = new Shader(this.gl, this.gl.VERTEX_SHADER, mainVertShaderCode);
        const mainFragShader: Shader = new Shader(this.gl, this.gl.FRAGMENT_SHADER, mainFragShaderCode);
        this.mainProgram = createProgram(this.gl, [mainVertShader, mainFragShader]);

        const viewportWidth: number = World3D.viewportRight;
        const viewportHeight: number = World3D.viewportBottom;

        this.viewportFramebuffer = this.gl.createFramebuffer()!;
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.viewportFramebuffer);

        this.viewportColorTarget = this.gl.createTexture()!;
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.viewportColorTarget);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, viewportWidth, viewportHeight, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, null);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);

        this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, this.viewportColorTarget, 0);

        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    }

    override startFrame(): void {
        // this.gl.clearColor(0.2, 0, 0, 1);
        // this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }

    override endFrame(): void {
        for (const texture of this.texturesToDelete) {
            this.gl.deleteTexture(texture);
        }
        this.texturesToDelete.length = 0;
    }

    override updateTexture(id: number): void {}

    override setBrightness(brightness: number): void {}

    override renderPixMap(pixMap: PixMap, x: number, y: number): boolean {
        this.gl.viewport(x, this.canvas.height - y - pixMap.height, pixMap.width, pixMap.height);

        const viewportWidth: number = World3D.viewportRight;
        const viewportHeight: number = World3D.viewportBottom;

        if (pixMap.width === viewportWidth && pixMap.height === viewportHeight) {
            this.gl.bindTexture(this.gl.TEXTURE_2D, this.viewportColorTarget);
            this.textureProgram.use();
            this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
        }

        const pixels: Uint8Array = new Uint8Array(pixMap.pixels.buffer);

        const texture: WebGLTexture = this.gl.createTexture()!;
        this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
        this.gl.texStorage2D(this.gl.TEXTURE_2D, 1, this.gl.RGBA8, pixMap.width, pixMap.height);
        this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, pixMap.width, pixMap.height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixels);
        // this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, pixMap.width, pixMap.height, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, new Uint8Array(pixMap.pixels.buffer));

        this.pixMapProgram.use();
        this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);

        this.texturesToDelete.push(texture);

        return true;
    }

    override startRenderScene(): void {
        this.isRenderingScene = true;
    }

    override endRenderScene(): void {
        this.isRenderingScene = false;

        const viewportWidth: number = World3D.viewportRight;
        const viewportHeight: number = World3D.viewportBottom;

        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.viewportFramebuffer);
        this.gl.viewport(0, 0, viewportWidth, viewportHeight);

        this.gl.clearColor(0.0, 0.0, 0.0, 1.0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);

        this.mainProgram.use();
        this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);

        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    }

    override fillTriangle(x0: number, x1: number, x2: number, y0: number, y1: number, y2: number, color: number): boolean {
        if (!this.isRenderingScene) {
            return false;
        }
        return true;
    }

    override fillGouraudTriangle(xA: number, xB: number, xC: number, yA: number, yB: number, yC: number, colorA: number, colorB: number, colorC: number): boolean {
        if (!this.isRenderingScene) {
            return false;
        }
        return true;
    }

    override fillTexturedTriangle(
        xA: number,
        xB: number,
        xC: number,
        yA: number,
        yB: number,
        yC: number,
        shadeA: number,
        shadeB: number,
        shadeC: number,
        originX: number,
        originY: number,
        originZ: number,
        txB: number,
        txC: number,
        tyB: number,
        tyC: number,
        tzB: number,
        tzC: number,
        texture: number
    ): boolean {
        if (!this.isRenderingScene) {
            return false;
        }
        return true;
    }

    override destroy(): void {}
}

import World3D from '../dash3d/World3D';
import Draw3D from '../graphics/Draw3D';
import {SHADER_CODE as computeRasterizerShaderCode} from './compute-rasterizer.wgsl';
import {SHADER_CODE as fullscreenPixelsShaderCode} from './fullscreen-pixels.wgsl';

const MAX_TRIANGLES: number = 100000;

const TEXTURE_COUNT: number = 50;

const TEXTURE_SIZE: number = 128;
const TEXTURE_PIXEL_COUNT: number = TEXTURE_SIZE * TEXTURE_SIZE;

const PALETTE_BYTES: number = 65536 * 4;
const TEXTURES_TRANSLUCENT_BYTES: number = TEXTURE_COUNT * 4;
const TEXTURES_BYTES: number = TEXTURE_COUNT * TEXTURE_PIXEL_COUNT * 4 * 4;

export class Renderer {
    static cpuRasterEnabled: boolean = true;

    static device: GPUDevice | undefined;

    static lutsBuffer: GPUBuffer;

    static flatTriangleDataBuffer: GPUBuffer | undefined;
    static gouraudTriangleDataBuffer: GPUBuffer | undefined;
    static texturedTriangleDataBuffer: GPUBuffer | undefined;
    static alphaTriangleDataBuffer: GPUBuffer | undefined;

    static triangleCount: number = 0;

    static flatTriangleData: Uint32Array = new Uint32Array(MAX_TRIANGLES * 8);
    static flatTriangleCount: number;

    static gouraudTriangleData: Uint32Array = new Uint32Array(MAX_TRIANGLES * 10);
    static gouraudTriangleCount: number = 0;

    static texturedTriangleData: Uint32Array = new Uint32Array(MAX_TRIANGLES * 20);
    static texturedTriangleCount: number = 0;

    static alphaTriangleData: Uint32Array = new Uint32Array(MAX_TRIANGLES * 10);
    static alphaTriangleCount: number = 0;

    static frameCount: number = 0;

    static render: () => void;

    static async init(): Promise<void> {
        const adapter: GPUAdapter | null = await navigator.gpu?.requestAdapter();
        const device: GPUDevice | undefined = await adapter?.requestDevice();
        if (!device) {
            return;
        }

        Renderer.device = device;

        // Get a WebGPU context from the canvas and configure it
        const canvas: HTMLCanvasElement = document.getElementById('canvas-webgpu') as HTMLCanvasElement;
        // @ts-expect-error: For some reason TS doesn't know about GPUCanvasContext
        const context: GPUCanvasContext | null = canvas.getContext('webgpu');
        if (!context) {
            return;
        }
        const presentationFormat: GPUTextureFormat = navigator.gpu.getPreferredCanvasFormat();
        context.configure({
            device,
            format: presentationFormat
        });

        const viewportWidth: number = World3D.viewportRight;
        const viewportHeight: number = World3D.viewportBottom;

        const uniformBuffer: GPUBuffer = device.createBuffer({
            size: 2 * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        device.queue.writeBuffer(uniformBuffer, 0, new Float32Array([viewportWidth, viewportHeight]));

        const pixelBuffer: GPUBuffer = device.createBuffer({
            size: viewportWidth * viewportHeight * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        const depthBuffer: GPUBuffer = device.createBuffer({
            size: viewportWidth * viewportHeight * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });

        const lutsBuffer: GPUBuffer = device.createBuffer({
            size: PALETTE_BYTES + TEXTURES_TRANSLUCENT_BYTES + TEXTURES_BYTES,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        Renderer.lutsBuffer = lutsBuffer;

        Renderer.updateBrightness();

        const rasterizerShaderModule: GPUShaderModule = device.createShaderModule({
            label: 'rasterizer shaders',
            code: computeRasterizerShaderCode
        });

        const rasterizerBindGroupLayout: GPUBindGroupLayout = device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: {type: 'storage'}
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: {type: 'storage'}
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: {type: 'read-only-storage'}
                }
            ]
        });

        const triangleDataBindGroupLayout: GPUBindGroupLayout = device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: {type: 'read-only-storage'}
                }
            ]
        });

        const rasterizerBindGroup: GPUBindGroup = device.createBindGroup({
            layout: rasterizerBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: pixelBuffer
                    }
                },
                {
                    binding: 1,
                    resource: {
                        buffer: depthBuffer
                    }
                },
                {
                    binding: 2,
                    resource: {
                        buffer: lutsBuffer
                    }
                }
            ]
        });

        const clearPipeline: GPUComputePipeline = device.createComputePipeline({
            label: 'clear pixels pipeline',
            layout: device.createPipelineLayout({bindGroupLayouts: [rasterizerBindGroupLayout]}),
            compute: {
                module: rasterizerShaderModule,
                entryPoint: 'clear'
            }
        });

        // depth
        const renderFlatDepthPipeline: GPUComputePipeline = device.createComputePipeline({
            label: 'render flat depth pipeline',
            layout: device.createPipelineLayout({bindGroupLayouts: [rasterizerBindGroupLayout, triangleDataBindGroupLayout]}),
            compute: {
                module: rasterizerShaderModule,
                entryPoint: 'renderFlatDepth'
            }
        });
        const renderGouraudDepthPipeline: GPUComputePipeline = device.createComputePipeline({
            label: 'render gouraud depth pipeline',
            layout: device.createPipelineLayout({bindGroupLayouts: [rasterizerBindGroupLayout, triangleDataBindGroupLayout]}),
            compute: {
                module: rasterizerShaderModule,
                entryPoint: 'renderGouraudDepth'
            }
        });
        const renderTexturedDepthPipeline: GPUComputePipeline = device.createComputePipeline({
            label: 'render textured depth pipeline',
            layout: device.createPipelineLayout({bindGroupLayouts: [rasterizerBindGroupLayout, triangleDataBindGroupLayout]}),
            compute: {
                module: rasterizerShaderModule,
                entryPoint: 'renderTexturedDepth'
            }
        });

        // color
        const renderFlatPipeline: GPUComputePipeline = device.createComputePipeline({
            label: 'render flat pipeline',
            layout: device.createPipelineLayout({bindGroupLayouts: [rasterizerBindGroupLayout, triangleDataBindGroupLayout]}),
            compute: {
                module: rasterizerShaderModule,
                entryPoint: 'renderFlat'
            }
        });
        const renderGouraudPipeline: GPUComputePipeline = device.createComputePipeline({
            label: 'render gouraud pipeline',
            layout: device.createPipelineLayout({bindGroupLayouts: [rasterizerBindGroupLayout, triangleDataBindGroupLayout]}),
            compute: {
                module: rasterizerShaderModule,
                entryPoint: 'renderGouraud'
            }
        });
        const renderTexturedPipeline: GPUComputePipeline = device.createComputePipeline({
            label: 'render textured pipeline',
            layout: device.createPipelineLayout({bindGroupLayouts: [rasterizerBindGroupLayout, triangleDataBindGroupLayout]}),
            compute: {
                module: rasterizerShaderModule,
                entryPoint: 'renderTextured'
            }
        });
        const renderAlphaPipeline: GPUComputePipeline = device.createComputePipeline({
            label: 'render alpha pipeline',
            layout: device.createPipelineLayout({bindGroupLayouts: [rasterizerBindGroupLayout, triangleDataBindGroupLayout]}),
            compute: {
                module: rasterizerShaderModule,
                entryPoint: 'renderAlpha'
            }
        });

        const fullscreenShaderModule: GPUShaderModule = device.createShaderModule({
            label: 'fullscreen pixels shaders',
            code: fullscreenPixelsShaderCode
        });

        const fullscreenPipeline: GPURenderPipeline = device.createRenderPipeline({
            label: 'fullscreen pixels pipeline',
            layout: 'auto',
            vertex: {
                module: fullscreenShaderModule
            },
            fragment: {
                module: fullscreenShaderModule,
                targets: [{format: presentationFormat}]
            }
        });

        const fullscreenBindGroup: GPUBindGroup = device.createBindGroup({
            layout: fullscreenPipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: uniformBuffer
                    }
                },
                {
                    binding: 1,
                    resource: {
                        buffer: pixelBuffer
                    }
                }
            ]
        });

        const renderPassDescriptor: GPURenderPassDescriptor = {
            label: 'main render pass',
            colorAttachments: [
                {
                    view: context.getCurrentTexture().createView(),
                    clearValue: {
                        r: 0.0,
                        g: 0.0,
                        b: 0.0,
                        a: 1.0
                    },
                    loadOp: 'clear',
                    storeOp: 'store'
                }
            ]
        };

        function render(): void {
            if (!device) {
                return;
            }

            const start: number = performance.now();

            for (const colorAttachment of renderPassDescriptor.colorAttachments) {
                colorAttachment!.view = context!.getCurrentTexture().createView();
            }

            let flatTriangleDataBuffer: GPUBuffer | undefined = Renderer.flatTriangleDataBuffer;
            if (flatTriangleDataBuffer) {
                flatTriangleDataBuffer.destroy();
                Renderer.flatTriangleDataBuffer = undefined;
            }
            let gouraudTriangleDataBuffer: GPUBuffer | undefined = Renderer.gouraudTriangleDataBuffer;
            if (gouraudTriangleDataBuffer) {
                gouraudTriangleDataBuffer.destroy();
                Renderer.gouraudTriangleDataBuffer = undefined;
            }
            let texturedTriangleDataBuffer: GPUBuffer | undefined = Renderer.texturedTriangleDataBuffer;
            if (texturedTriangleDataBuffer) {
                texturedTriangleDataBuffer.destroy();
                Renderer.texturedTriangleDataBuffer = undefined;
            }
            let alphaTriangleDataBuffer: GPUBuffer | undefined = Renderer.alphaTriangleDataBuffer;
            if (alphaTriangleDataBuffer) {
                alphaTriangleDataBuffer.destroy();
                Renderer.alphaTriangleDataBuffer = undefined;
            }

            let flatTriangleDataBindGroup: GPUBindGroup | undefined;
            if (Renderer.flatTriangleCount > 0) {
                flatTriangleDataBuffer = device.createBuffer({
                    size: Renderer.flatTriangleCount * 8 * 4,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
                });
                Renderer.flatTriangleDataBuffer = flatTriangleDataBuffer;
                device.queue.writeBuffer(flatTriangleDataBuffer, 0, Renderer.flatTriangleData.subarray(0, Renderer.flatTriangleCount * 8));

                flatTriangleDataBindGroup = device.createBindGroup({
                    layout: triangleDataBindGroupLayout,
                    entries: [
                        {
                            binding: 0,
                            resource: {
                                buffer: flatTriangleDataBuffer
                            }
                        }
                    ]
                });
            }
            let gouraudTriangleDataBindGroup: GPUBindGroup | undefined;
            if (Renderer.gouraudTriangleCount > 0) {
                gouraudTriangleDataBuffer = device.createBuffer({
                    size: Renderer.gouraudTriangleCount * 10 * 4,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
                });
                Renderer.gouraudTriangleDataBuffer = gouraudTriangleDataBuffer;
                device.queue.writeBuffer(gouraudTriangleDataBuffer, 0, Renderer.gouraudTriangleData.subarray(0, Renderer.gouraudTriangleCount * 10));

                gouraudTriangleDataBindGroup = device.createBindGroup({
                    layout: triangleDataBindGroupLayout,
                    entries: [
                        {
                            binding: 0,
                            resource: {
                                buffer: gouraudTriangleDataBuffer
                            }
                        }
                    ]
                });
            }
            let texturedTriangleDataBindGroup: GPUBindGroup | undefined;
            if (Renderer.texturedTriangleCount > 0) {
                texturedTriangleDataBuffer = device.createBuffer({
                    size: Renderer.texturedTriangleCount * 20 * 4,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
                });
                Renderer.texturedTriangleDataBuffer = texturedTriangleDataBuffer;
                device.queue.writeBuffer(texturedTriangleDataBuffer, 0, Renderer.texturedTriangleData.subarray(0, Renderer.texturedTriangleCount * 20));

                texturedTriangleDataBindGroup = device.createBindGroup({
                    layout: triangleDataBindGroupLayout,
                    entries: [
                        {
                            binding: 0,
                            resource: {
                                buffer: texturedTriangleDataBuffer
                            }
                        }
                    ]
                });
            }
            let alphaTriangleDataBindGroup: GPUBindGroup | undefined;
            if (Renderer.alphaTriangleCount > 0) {
                alphaTriangleDataBuffer = device.createBuffer({
                    size: Renderer.alphaTriangleCount * 10 * 4,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
                });
                Renderer.alphaTriangleDataBuffer = alphaTriangleDataBuffer;
                device.queue.writeBuffer(alphaTriangleDataBuffer, 0, Renderer.alphaTriangleData.subarray(0, Renderer.alphaTriangleCount * 10));

                alphaTriangleDataBindGroup = device.createBindGroup({
                    layout: triangleDataBindGroupLayout,
                    entries: [
                        {
                            binding: 0,
                            resource: {
                                buffer: alphaTriangleDataBuffer
                            }
                        }
                    ]
                });
            }

            const encoder: GPUCommandEncoder = device.createCommandEncoder({
                label: 'render command encoder'
            });

            const computePass: GPUComputePassEncoder = encoder.beginComputePass();

            computePass.setPipeline(clearPipeline);
            computePass.setBindGroup(0, rasterizerBindGroup);
            // computePass.setBindGroup(1, callsBindGroup);
            computePass.dispatchWorkgroups(Math.ceil((viewportWidth * viewportHeight) / 256));

            // render depth
            if (Renderer.flatTriangleCount > 0 && flatTriangleDataBindGroup) {
                computePass.setPipeline(renderFlatDepthPipeline);
                computePass.setBindGroup(0, rasterizerBindGroup);
                computePass.setBindGroup(1, flatTriangleDataBindGroup);
                computePass.dispatchWorkgroups(Renderer.flatTriangleCount);
            }
            if (Renderer.gouraudTriangleCount > 0 && gouraudTriangleDataBindGroup) {
                computePass.setPipeline(renderGouraudDepthPipeline);
                computePass.setBindGroup(0, rasterizerBindGroup);
                computePass.setBindGroup(1, gouraudTriangleDataBindGroup);
                computePass.dispatchWorkgroups(Renderer.gouraudTriangleCount);
            }
            if (Renderer.texturedTriangleCount > 0 && texturedTriangleDataBindGroup) {
                computePass.setPipeline(renderTexturedDepthPipeline);
                computePass.setBindGroup(0, rasterizerBindGroup);
                computePass.setBindGroup(1, texturedTriangleDataBindGroup);
                computePass.dispatchWorkgroups(Renderer.texturedTriangleCount);
            }

            // render color
            if (Renderer.flatTriangleCount > 0 && flatTriangleDataBindGroup) {
                computePass.setPipeline(renderFlatPipeline);
                computePass.setBindGroup(0, rasterizerBindGroup);
                computePass.setBindGroup(1, flatTriangleDataBindGroup);
                computePass.dispatchWorkgroups(Renderer.flatTriangleCount);
            }
            if (Renderer.gouraudTriangleCount > 0 && gouraudTriangleDataBindGroup) {
                computePass.setPipeline(renderGouraudPipeline);
                computePass.setBindGroup(0, rasterizerBindGroup);
                computePass.setBindGroup(1, gouraudTriangleDataBindGroup);
                computePass.dispatchWorkgroups(Renderer.gouraudTriangleCount);
            }
            if (Renderer.texturedTriangleCount > 0 && texturedTriangleDataBindGroup) {
                computePass.setPipeline(renderTexturedPipeline);
                computePass.setBindGroup(0, rasterizerBindGroup);
                computePass.setBindGroup(1, texturedTriangleDataBindGroup);
                computePass.dispatchWorkgroups(Renderer.texturedTriangleCount);
            }
            if (Renderer.alphaTriangleCount > 0 && alphaTriangleDataBindGroup) {
                computePass.setPipeline(renderAlphaPipeline);
                computePass.setBindGroup(0, rasterizerBindGroup);
                computePass.setBindGroup(1, alphaTriangleDataBindGroup);
                computePass.dispatchWorkgroups(1);
            }

            computePass.end();

            const pass: GPURenderPassEncoder = encoder.beginRenderPass(renderPassDescriptor);

            pass.setViewport(8, 11, viewportWidth, viewportHeight, 0, 1);

            pass.setPipeline(fullscreenPipeline);
            pass.setBindGroup(0, fullscreenBindGroup);
            pass.draw(3);

            pass.end();

            const commandBuffer: GPUCommandBuffer = encoder.finish();
            device.queue.submit([commandBuffer]);

            const end: number = performance.now();

            if (Renderer.frameCount % 200 === 0) {
                console.log(`Render time: ${end - start}ms`);
            }

            Renderer.frameCount++;
        }

        // const start = performance.now();
        render();
        // const end = performance.now();

        // console.log(`Render time: ${end - start}ms`);

        Renderer.render = render;
    }

    static updateBrightness(): void {
        const device: GPUDevice | undefined = Renderer.device;
        if (!device) {
            return;
        }

        // Update palette
        device.queue.writeBuffer(Renderer.lutsBuffer, 0, new Uint32Array(Draw3D.palette));

        Renderer.updateTextures();
    }

    static updateTextures(): void {
        const device: GPUDevice | undefined = Renderer.device;
        if (!device) {
            return;
        }

        for (let i: number = 0; i < TEXTURE_COUNT; i++) {
            Renderer.updateTexture(i);
        }
        const texturesTranslucentData: Uint32Array = new Uint32Array(TEXTURES_TRANSLUCENT_BYTES);
        for (let i: number = 0; i < TEXTURE_COUNT; i++) {
            texturesTranslucentData[i] = Draw3D.textureTranslucent[i] ? 1 : 0;
        }
        device.queue.writeBuffer(Renderer.lutsBuffer, PALETTE_BYTES, texturesTranslucentData);
    }

    static updateTexture(id: number): void {
        const device: GPUDevice | undefined = Renderer.device;
        if (!device) {
            return;
        }

        const texels: Int32Array | null = Draw3D.getTexels(id);
        if (!texels) {
            return;
        }
        device.queue.writeBuffer(Renderer.lutsBuffer, PALETTE_BYTES + TEXTURES_TRANSLUCENT_BYTES + id * TEXTURE_PIXEL_COUNT * 4 * 4, new Uint32Array(texels));
    }

    static setBrightness(brightness: number): void {
        Renderer.updateBrightness();
    }

    static startRenderScene(): void {
        Renderer.triangleCount = 0;
        Renderer.flatTriangleCount = 0;
        Renderer.texturedTriangleCount = 0;
        Renderer.gouraudTriangleCount = 0;
        Renderer.alphaTriangleCount = 0;
    }

    static fillTriangle = (x0: number, x1: number, x2: number, y0: number, y1: number, y2: number, color: number): boolean => {
        if (Renderer.flatTriangleCount >= MAX_TRIANGLES) {
            return !Renderer.cpuRasterEnabled;
        }
        const triangleIndex: number = Renderer.triangleCount++;
        if (Draw3D.alpha !== 0) {
            let offset: number = Renderer.alphaTriangleCount * 10;

            Renderer.alphaTriangleData[offset++] = (1 << 31) | (Draw3D.alpha << 23) | triangleIndex;
            Renderer.alphaTriangleData[offset++] = x0;
            Renderer.alphaTriangleData[offset++] = x1;
            Renderer.alphaTriangleData[offset++] = x2;
            Renderer.alphaTriangleData[offset++] = y0;
            Renderer.alphaTriangleData[offset++] = y1;
            Renderer.alphaTriangleData[offset++] = y2;
            Renderer.alphaTriangleData[offset++] = color;

            Renderer.alphaTriangleCount++;
        } else {
            let offset: number = Renderer.flatTriangleCount * 8;

            Renderer.flatTriangleData[offset++] = triangleIndex;
            Renderer.flatTriangleData[offset++] = x0;
            Renderer.flatTriangleData[offset++] = x1;
            Renderer.flatTriangleData[offset++] = x2;
            Renderer.flatTriangleData[offset++] = y0;
            Renderer.flatTriangleData[offset++] = y1;
            Renderer.flatTriangleData[offset++] = y2;
            Renderer.flatTriangleData[offset++] = color;

            Renderer.flatTriangleCount++;
        }
        return !Renderer.cpuRasterEnabled;
    };

    static fillGouraudTriangle = (xA: number, xB: number, xC: number, yA: number, yB: number, yC: number, colorA: number, colorB: number, colorC: number): boolean => {
        if (Renderer.gouraudTriangleCount >= MAX_TRIANGLES) {
            return !Renderer.cpuRasterEnabled;
        }
        const triangleIndex: number = Renderer.triangleCount++;
        if (Draw3D.alpha !== 0) {
            let offset: number = Renderer.alphaTriangleCount * 10;

            Renderer.alphaTriangleData[offset++] = (Draw3D.alpha << 23) | triangleIndex;
            Renderer.alphaTriangleData[offset++] = xA;
            Renderer.alphaTriangleData[offset++] = xB;
            Renderer.alphaTriangleData[offset++] = xC;
            Renderer.alphaTriangleData[offset++] = yA;
            Renderer.alphaTriangleData[offset++] = yB;
            Renderer.alphaTriangleData[offset++] = yC;
            Renderer.alphaTriangleData[offset++] = colorA;
            Renderer.alphaTriangleData[offset++] = colorB;
            Renderer.alphaTriangleData[offset++] = colorC;

            Renderer.alphaTriangleCount++;
        } else {
            let offset: number = Renderer.gouraudTriangleCount * 10;

            Renderer.gouraudTriangleData[offset++] = triangleIndex;
            Renderer.gouraudTriangleData[offset++] = xA;
            Renderer.gouraudTriangleData[offset++] = xB;
            Renderer.gouraudTriangleData[offset++] = xC;
            Renderer.gouraudTriangleData[offset++] = yA;
            Renderer.gouraudTriangleData[offset++] = yB;
            Renderer.gouraudTriangleData[offset++] = yC;
            Renderer.gouraudTriangleData[offset++] = colorA;
            Renderer.gouraudTriangleData[offset++] = colorB;
            Renderer.gouraudTriangleData[offset++] = colorC;

            Renderer.gouraudTriangleCount++;
        }
        return !Renderer.cpuRasterEnabled;
    };

    static fillTexturedTriangle = (
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
    ): boolean => {
        if (Renderer.texturedTriangleCount >= MAX_TRIANGLES) {
            return !Renderer.cpuRasterEnabled;
        }
        let offset: number = Renderer.texturedTriangleCount * 20;

        const triangleIndex: number = Renderer.triangleCount++;

        Renderer.texturedTriangleData[offset++] = triangleIndex;
        Renderer.texturedTriangleData[offset++] = xA;
        Renderer.texturedTriangleData[offset++] = xB;
        Renderer.texturedTriangleData[offset++] = xC;
        Renderer.texturedTriangleData[offset++] = yA;
        Renderer.texturedTriangleData[offset++] = yB;
        Renderer.texturedTriangleData[offset++] = yC;
        Renderer.texturedTriangleData[offset++] = shadeA;
        Renderer.texturedTriangleData[offset++] = shadeB;
        Renderer.texturedTriangleData[offset++] = shadeC;
        Renderer.texturedTriangleData[offset++] = originX;
        Renderer.texturedTriangleData[offset++] = originY;
        Renderer.texturedTriangleData[offset++] = originZ;
        Renderer.texturedTriangleData[offset++] = txB;
        Renderer.texturedTriangleData[offset++] = txC;
        Renderer.texturedTriangleData[offset++] = tyB;
        Renderer.texturedTriangleData[offset++] = tyC;
        Renderer.texturedTriangleData[offset++] = tzB;
        Renderer.texturedTriangleData[offset++] = tzC;
        Renderer.texturedTriangleData[offset++] = texture;

        Renderer.texturedTriangleCount++;
        return !Renderer.cpuRasterEnabled;
    };
}

import Draw3D from '../graphics/Draw3D';
import {SHADER_CODE as computeRasterizerShaderCode} from './compute-rasterizer.wgsl';
import {SHADER_CODE as fullscreenPixelsShaderCode} from './fullscreen-pixels.wgsl';

const MAX_CALLS: number = 2560;

const TEXTURE_COUNT: number = 50;

const TEXTURE_SIZE: number = 128;
const TEXTURE_PIXEL_COUNT: number = TEXTURE_SIZE * TEXTURE_SIZE;

const PALETTE_BYTES: number = 65536 * 4;
const TEXTURES_TRANSLUCENT_BYTES: number = TEXTURE_COUNT * 4;
const TEXTURES_BYTES: number = TEXTURE_COUNT * TEXTURE_PIXEL_COUNT * 4 * 4;

export class Renderer {
    static device: GPUDevice | undefined;

    static lutsBuffer: GPUBuffer;

    static callsBuffer: GPUBuffer | undefined;

    static callsData: Uint32Array = new Uint32Array(MAX_CALLS * 19);
    static callCount: number = 0;

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

        const uniformBuffer: GPUBuffer = device.createBuffer({
            size: 2 * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        device.queue.writeBuffer(uniformBuffer, 0, new Float32Array([canvas.width, canvas.height]));

        const pixelBuffer: GPUBuffer = device.createBuffer({
            size: canvas.width * canvas.height * 4,
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
                    buffer: {type: 'read-only-storage'}
                }
            ]
        });

        const callsBufferBindGroupLayout: GPUBindGroupLayout = device.createBindGroupLayout({
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

        const computeRenderPipeline: GPUComputePipeline = device.createComputePipeline({
            label: 'compute render pipeline',
            layout: device.createPipelineLayout({bindGroupLayouts: [rasterizerBindGroupLayout, callsBufferBindGroupLayout]}),
            compute: {
                module: rasterizerShaderModule,
                entryPoint: 'render'
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

            let callsBuffer: GPUBuffer | undefined = Renderer.callsBuffer;
            if (callsBuffer) {
                callsBuffer.destroy();
            }
            callsBuffer = device.createBuffer({
                size: Math.max(Renderer.callCount, 1) * 19 * 4,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
            });
            Renderer.callsBuffer = callsBuffer;
            device.queue.writeBuffer(callsBuffer, 0, Renderer.callsData.subarray(0, Renderer.callCount * 19));

            const callsBindGroup: GPUBindGroup = device.createBindGroup({
                layout: callsBufferBindGroupLayout,
                entries: [
                    {
                        binding: 0,
                        resource: {
                            buffer: callsBuffer
                        }
                    }
                ]
            });

            const encoder: GPUCommandEncoder = device.createCommandEncoder({
                label: 'render command encoder'
            });

            const computePass: GPUComputePassEncoder = encoder.beginComputePass();

            computePass.setPipeline(clearPipeline);
            computePass.setBindGroup(0, rasterizerBindGroup);
            computePass.setBindGroup(1, callsBindGroup);
            computePass.dispatchWorkgroups(Math.ceil((canvas.width * canvas.height) / 256));

            if (Renderer.callCount > 0) {
                computePass.setPipeline(computeRenderPipeline);
                computePass.setBindGroup(0, rasterizerBindGroup);
                computePass.setBindGroup(1, callsBindGroup);
                // computePass.dispatchWorkgroups(1);
                computePass.dispatchWorkgroups(Renderer.callCount);
            }

            computePass.end();

            const pass: GPURenderPassEncoder = encoder.beginRenderPass(renderPassDescriptor);

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
        Renderer.callCount = 0;
    }

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
    ): void => {
        if (Renderer.callCount >= MAX_CALLS) {
            return;
        }
        const offset: number = Renderer.callCount * 19;

        Renderer.callsData[offset] = xA;
        Renderer.callsData[offset + 1] = xB;
        Renderer.callsData[offset + 2] = xC;
        Renderer.callsData[offset + 3] = yA;
        Renderer.callsData[offset + 4] = yB;
        Renderer.callsData[offset + 5] = yC;
        Renderer.callsData[offset + 6] = shadeA;
        Renderer.callsData[offset + 7] = shadeB;
        Renderer.callsData[offset + 8] = shadeC;
        Renderer.callsData[offset + 9] = originX;
        Renderer.callsData[offset + 10] = originY;
        Renderer.callsData[offset + 11] = originZ;
        Renderer.callsData[offset + 12] = txB;
        Renderer.callsData[offset + 13] = txC;
        Renderer.callsData[offset + 14] = tyB;
        Renderer.callsData[offset + 15] = tyC;
        Renderer.callsData[offset + 16] = tzB;
        Renderer.callsData[offset + 17] = tzC;
        Renderer.callsData[offset + 18] = texture;

        Renderer.callCount++;
    };
}

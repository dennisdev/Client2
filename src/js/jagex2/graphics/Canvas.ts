export const dummyCanvas: HTMLCanvasElement = document.createElement('canvas');
export const canvas: HTMLCanvasElement = document.getElementById('canvas') as HTMLCanvasElement;
// TODO: code using this will currently do nothing
export const canvas2d: CanvasRenderingContext2D = dummyCanvas.getContext('2d', {willReadFrequently: true})!;
// TODO: add code for switching between canvas2d and webgl2 because they are incompatible for the same canvas
export const gl: WebGL2RenderingContext = canvas.getContext('webgl2', {preserveDrawingBuffer: true})!;

export const jpegCanvas: HTMLCanvasElement = document.createElement('canvas');
export const jpegImg: HTMLImageElement = document.createElement('img');
export const jpeg2d: CanvasRenderingContext2D = jpegCanvas.getContext('2d', {willReadFrequently: true})!;

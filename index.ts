/**
 * WebUSB driver for CH34x USB to serial adapter
 * commands based on
 * - https://github.com/mik3y/usb-serial-for-android/blob/master/usbSerialForAndroid/src/main/java/com/hoho/android/usbserial/driver/Ch34xSerialDriver.java
 * - https://github.com/selevo/WebUsbSerialTerminal/blob/main/serial.js
 * structure based on https://github.com/emcee5601/pl2303
 */

const REQUEST_READ_VERSION =0x5F;
const REQUEST_READ_REGISTRY = 0x95;
const REQUEST_WRITE_REGISTRY = 0x9A;
const REQUEST_SERIAL_INITIATION = 0xA1;

const REG_MODEM_CTRL = 0xA4;
const REG_BAUD_FACTOR = 0x1312;
const REG_BAUD_OFFSET = 0x0F2C;
const REG_BAUD_LOW = 0x2518;

const LCR_ENABLE_RX = 0x80;
const LCR_ENABLE_TX = 0x40;
const LCR_CS8 = 0x03;

const SCL_DTR = 0x20;
const SCL_RTS = 0x40;

export const VENDOR_ID_QUINHENG = 0x1a86
export const PRODUCT_ID_CH340 = 0x7523;
export const PRODUCT_ID_CH341A = 0x5523;


export default class CH34xUsbSerial extends EventTarget {
    private readonly device: USBDevice;
    private isClosing: boolean = false;
    private bitrate: number = 9600;
    private readEndpoint: USBEndpoint | undefined;
    private writeEndpoint: USBEndpoint | undefined;
    private dtr: boolean = true;
    private rts: boolean = true;

    constructor(device: USBDevice, opts: { baudRate: number }) {
        super();
        this.bitrate = opts.baudRate;
        this.device = device;
    }

    async vendorOut(request: number, value: number, index: number = 0) {
        await this.device.controlTransferOut({
            requestType: 'vendor',
            recipient: 'device',
            request: request,
            value,
            index,
        }).then(result => {
            console.log(`vendorOut success `, result)
        }).catch(reason => {
            console.warn(`vendorOut failed ${reason}`)
        });
    }

    async vendorIn(request: number, value: number, index: number, length: number) {
        return this.device.controlTransferIn({
            requestType: 'vendor',
            recipient: 'device',
            request: request,
            value,
            index
        }, length)
    }

    async checkState(message: string, request: number, value: number, expected: ArrayBuffer) {
        const result = await this.vendorIn(request, value, 0, expected.byteLength)
        if (result.status !== "ok" || !result.data) {
            console.error(`failed to send ${message}, status ${result.status}, data:`, result.data)
            return false
        }
        if (result.data.byteLength !== expected.byteLength) {
            console.error(`error sending command ${message}, expected ${expected.byteLength}, got ${result.data.byteLength} instead`)
            return false
        }
        if (result.data.buffer !== expected) {
            // todo: do we need byte-by-byte comparison?
            console.error(`error sending command ${message}, expected `, expected, ` got `, result.data.buffer)
            return false
        }
        return true
    }


    async setBaudRate(baudRate: number) {
        let factor: number;
        let divisor: number;

        if (baudRate === 921600) {
            divisor = 7;
            factor = 0xf300;
        } else {
            const baseFactor = 1532620800
            const divmax = 3;
            factor = baseFactor / baudRate;
            divisor = divmax;
            while ((factor > 0xfff0) && divisor > 0) {
                factor >>= 3;
                divisor--;
            }
            if (factor > 0xfff0) {
                console.error(`unsupported baud rate ${baudRate}`)
                throw new Error(`unsupported baud rate ${baudRate}`)
            }
            factor = 0x10000 - factor;
        }
        divisor |= 0x0080;
        const val1 = (factor & 0xff00) | divisor
        const val2 = (factor & 0xff)
        console.debug(`set baud rate ${baudRate}, v1=${val1}, v2=${val2}`)
        await this.vendorOut(REQUEST_WRITE_REGISTRY, REG_BAUD_FACTOR, val1)
        await this.vendorOut(REQUEST_WRITE_REGISTRY, REG_BAUD_OFFSET, val2)
    }

    async open() {
        (async () => {
            await this.device.open();
            // assert(this.device.configuration.interfaces.length === 1);

            const interfaces = this.device.configuration ? this.device.configuration.interfaces : [];
            await Promise.all(interfaces.map(async (iface) => {
                console.log('Claiming interface', iface.interfaceNumber);
                try {
                    return await this.device.claimInterface(iface.interfaceNumber);
                } catch (reason) {
                    return console.error("error claiming interface ", iface, `;, reason: ${reason}`);
                }
            }))

            const dataInterface = interfaces[interfaces.length - 1];
            // determine read and write endpoint
            dataInterface.alternate.endpoints.forEach((endpoint) => {
                if(endpoint.type === 'bulk') {
                    switch (endpoint.direction) {
                        case "in":
                            this.readEndpoint = endpoint;
                            break
                        case "out":
                            this.writeEndpoint = endpoint;
                            break;
                        default:
                            console.error(`endpoint ${endpoint.endpointNumber} has unexpected direction: ${endpoint.direction}`);
                            break;
                    }
                } else {
                    console.debug("ignoring non-bulk endpoint: ", endpoint)
                }
            })

            await this.init()
            await this.setBaudRate(this.bitrate);

            this.isClosing = false;
            await this.readLoop();

            this.dispatchEvent(new Event('ready'));
        })().catch((error) => {
            console.log('Error during CH34x setup:', error);
            this.dispatchEvent(new CustomEvent('error', {
                detail: error,
            }));
        });
    }

    private async readLoop() {
        if (!this.readEndpoint) {
            console.error("no read endpoint, aborting readLoop()")
            await this.close();
            return
        }
        // 64 doesn't seem to work, but 32 does. and 32 seems to be what the packetSize is, so use whatever packetSize is
        this.device.transferIn(this.readEndpoint.endpointNumber, this.readEndpoint.packetSize).then((result) => {
            if (result && result.data && result.data.byteLength) {
                console.log(`Received ${result.data.byteLength} byte(s).`);
                const uint8buffer = new Uint8Array(result.data.buffer);
                this.dispatchEvent(new CustomEvent('data', {
                    detail: uint8buffer.slice(0),
                }));
            } else {
                console.log("transferIn got no result, no result data, or data was empty")
            }

        }).catch((error) => {
                if (error.message.indexOf('LIBUSB_TRANSFER_NO_DEVICE')) {
                    console.warn('Device disconnected');
                    this.dispatchEvent(new Event('disconnected'));
                    this.isClosing = true; // flag this so we don't keep hitting this error
                } else {
                    console.error('Error reading data:', error);
                }
            }
        ).finally(async () => {
            if (!this.isClosing && this.device.opened) {
                await this.readLoop();
            }
        })
    }

    async close() {
        this.isClosing = true;
        this.dispatchEvent(new Event('disconnected'));
        return new Promise<void>((resolve, reject) => {
            setTimeout(async () => {
                try {
                    await this.device.releaseInterface(0);
                    await this.device.close();
                    resolve();
                } catch (err) {
                    console.error('Error while closing:', err);
                    reject(err);
                }
            }, 2000);

        })
    }

    async write(data: BufferSource): Promise<USBOutTransferResult> {
        return new Promise((resolve, reject) => {
            if (!this.writeEndpoint) {
                reject("no writeEndpoint");
                return;
            }
            this.device.transferOut(this.writeEndpoint?.endpointNumber, data).then(() => {
                resolve({status: "ok", bytesWritten: data.byteLength});
            }).catch((err) => {
                console.error(`error writing to ${this.device.constructor.name}: ${err}`)
                reject(err)
            })
        })
    }

    async setControlLines() {
        return this.vendorOut(REG_MODEM_CTRL, ~((this.dtr ? SCL_DTR : 0) | (this.rts ? SCL_RTS : 0)), 0)
    }

    private async init() {
        const DEFAULT_BAUD_RATE = 9600
        // these checkstate calls fail, but we're still able to communicate, so leave them as is for now, but ignore
        await this.checkState("init 1", REQUEST_READ_VERSION, 0, new Uint8Array([-1, 0x00]))
        await this.vendorOut(REQUEST_SERIAL_INITIATION, 0, 0)

        await this.setBaudRate(DEFAULT_BAUD_RATE)
        await this.checkState("init 4", REQUEST_READ_REGISTRY, REG_BAUD_LOW, new Uint8Array([-1, 0x00]))

        await this.vendorOut(REQUEST_WRITE_REGISTRY, REG_BAUD_LOW, LCR_ENABLE_TX | LCR_ENABLE_RX | LCR_CS8)
        await this.checkState("init 6", REQUEST_READ_REGISTRY, 0x0706, new Uint8Array([-1, -1]))

        await this.vendorOut(REQUEST_SERIAL_INITIATION, 0x501f, 0xd90a)
        await this.setBaudRate(DEFAULT_BAUD_RATE)

        await this.setControlLines()
        await this.checkState("init 10", REQUEST_READ_REGISTRY, 0x0706, new Uint8Array([-1, -1]));
    }
}

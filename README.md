# ch34x-webusb-serial-ts
WebUSB driver for CH34x USB to serial adapter

```typescript
import CH34xUsbSerial, {PRODUCT_ID_CH340, VENDOR_ID_QUINHENG} from "./index";

navigator.usb.requestDevice({filters: [{vendorId: VENDOR_ID_QUINHENG, productId: PRODUCT_ID_CH340}]}).then(device => {
  const driver = new CH34xUsbSerial(device, {baudRate: 1200})

  driver.addEventListener('data', (event) => {
    const chunk: Uint8Array = (event as CustomEvent).detail;
    console.debug("data:", chunk)
    driver.write(chunk).then((result) => console.debug("write successful", result)).catch((reason) => {
      console.debug("write error", reason)
    })
  })
  driver.addEventListener('ready', () => {
    console.debug("ready!")
  })
  driver.addEventListener('error', (event: Event) => {
    console.debug("error", event)
  })
  driver.addEventListener('disconnected', () => {
    console.debug("disconnected")
  })
  driver.open();
})

```

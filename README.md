# cncjs-pendant-raspi-gpio
Simple Raspberry Pi GPIO Pendant control for CNCjs.

![image-1](https://github.com/cncjs/cncjs-pendant-raspi-gpio/raw/master/docs/image-1.jpg)

## Installation
#### NPM Install
```
npm install cncjs-pendant-raspi-gpio
```
#### Manual Install
```
wget https://github.com/cncjs/cncjs-pendant-raspi-gpio/archive/master.zip
unzip cncjs-pendant-raspi-gpio*.zip
cd cncjs-pendant-raspi-gpio*
npm install cncjs-pendant-raspi-gpio
```

## Usage
Run `bin/cncjs-pendant-raspi-gpio` to start. Pass --help to `cncjs-pendant-raspi-gpio` for more options.

Eamples:

```
bin/cncjs-pendant-keyboard --help
node bin/cncjs-pendant-raspi-gpio  --port /dev/ttyUSB0
```

#### Button Presses
 1. G-Code: M9
 2. G-Code: M8
 3. G-Code: M7
 4. G-Code: $X "Unlock"
 5. G-Code: $X "Unlock"
 6. blank
 7. blank
 8. G-Code: $H "Home"

#### Press & Hold
 - 3 Sec: sudo poweroff "Shutdown"

### Wiring 
![image-4](https://github.com/cncjs/cncjs-pendant-raspi-gpio/raw/master/docs/image-4.jpg)

![image-3](https://github.com/cncjs/cncjs-pendant-raspi-gpio/raw/master/docs/image-3.jpg)

![image-2](https://github.com/cncjs/cncjs-pendant-raspi-gpio/raw/master/docs/image-2.jpg)

![raspberry_pi_circuit_note](http://www.jameco.com/Jameco/workshop/circuitnotes/raspberry_pi_circuit_note_fig2a.jpg)
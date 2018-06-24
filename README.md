# cncjs-pendant-raspi-gpio
Simple Raspberry Pi GPIO Pendant control for CNCjs.

[![NPM](https://nodei.co/npm/cncjs-pendant-raspi-gpio.png?compact=true)](https://nodei.co/npm/cncjs-pendant-raspi-gpio/)

![image-1](https://github.com/cncjs/cncjs-pendant-raspi-gpio/raw/master/docs/image-1.jpg)

## Installation
#### NPM Install (local)
```
npm install cncjs-pendant-raspi-gpio
```
#### NPM Install (global) [Recommended]
```
sudo npm install -g cncjs-pendant-raspi-gpio@latest --unsafe-perm --build-from-source
```

#### Manual Install
```
# Clone Repository
cd ~/
#wget https://github.com/cncjs/cncjs-pendant-raspi-gpio/archive/master.zip
#unzip master.zip
git clone https://github.com/cncjs/cncjs-pendant-raspi-gpio.git
cd cncjs-pendant-raspi-gpio*
npm install
```

## Usage
Run `bin/cncjs-pendant-raspi-gpio` to start. Pass --help to `cncjs-pendant-raspi-gpio` for more options.

Eamples:

```
bin/cncjs-pendant-keyboard --help
node bin/cncjs-pendant-raspi-gpio  --port /dev/ttyUSB0
```

#### Auto Start

###### Install [Production Process Manager [PM2]](http://pm2.io)
```
# Install PM2
sudo npm install -g pm2

# Setup PM2 Startup Script
# sudo pm2 startup  # To Start PM2 as root
pm2 startup  # To start PM2 as pi / current user
  #[PM2] You have to run this command as root. Execute the following command:
  sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u pi --hp /home/pi

# Start CNCjs (on port 8000, /w Tinyweb mount point) with PM2
## pm2 start ~/cncjs-pendant-raspi-gpio/bin/cncjs-pendant-raspi-gpio -- --port /dev/ttyUSB0
pm2 start $(which cncjs-pendant-raspi-gpio) -- --port /dev/ttyUSB0

# Set current running apps to startup
pm2 save

# Get list of PM2 processes
pm2 list
```

#### Button Presses
 1. G-Code: M9
 2. G-Code: M8
 3. G-Code: M7
 4. G-Code: $X "Unlock"
 5. G-Code: $X "Unlock"
 6. G-Code: $SLP "Sleep"
 7. G-Code: $SLP "Sleep"
 8. G-Code: $H "Home"

#### Press & Hold
 - 3 Sec: sudo poweroff "Shutdown"

## Wiring 

See the [fivdi/onoff](https://www.npmjs.com/package/onoff) Raspberry Pi GPIO NodeJS repository for more infomation.
![nodejs onoff diagram](https://raw.githubusercontent.com/fivdi/onoff/master/examples/light-switch.png)

![raspberry_pi_circuit_note](http://www.jameco.com/Jameco/workshop/circuitnotes/raspberry_pi_circuit_note_fig2a.jpg)

![image-4](https://github.com/cncjs/cncjs-pendant-raspi-gpio/raw/master/docs/image-4.jpg)

![image-3](https://github.com/cncjs/cncjs-pendant-raspi-gpio/raw/master/docs/image-3.jpg)

![image-2](https://github.com/cncjs/cncjs-pendant-raspi-gpio/raw/master/docs/image-2.jpg)

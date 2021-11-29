const { CybroComm } = require('./comm');
const EventEmitter = require('events');
const JSZip = require('jszip');

class CybroController extends EventEmitter {

	constructor(address, port, nad, password) {
		super();

		let controller = this;

		// Link parameters
		this.address = address;
		this.port = port;
		this.nad = nad;
		this.password = password;

		this.sockets = [];
		this.plcStatus = null;
		this.fileDescriptorSize = 46;

		// TODO pick nadFrom from range
		this.comm = new CybroComm(this, this.address, this.port, this.nad, this.password);

		this.comm.on('socket', (frame) => {
			this._processSocket(frame);
		});
	}

	async connect() {
		await this.comm.connect();
	}

	async ping() {
		return await this.comm.ping();
	}

	async status() {
		this.plcStatus = await this.comm.status();
		return this.plcStatus;
	}

	async write(variables) {
		if (variables instanceof Array) {
			return await this.comm.write(variables);
		} else {
			return await this.comm.write([variables]);
		}
	}

	async read(variables) {
		if (variables instanceof Array) {
			return await this.comm.read(variables);
		} else {
			return (await this.comm.read([variables]))[0];
		}
	}

	async plcStart() {
		let success = await this.comm.plcStart();
		if (success) {
			this.plcStatus = 2;
		}
		return success;
	}

	async plcStop() {
		let success = await this.comm.plcStop();
		if (success) {
			this.plcStatus = 0;
		}
		return success;
	}

	async plcPause() {
		let success = await this.comm.plcPause();
		if (success) {
			this.plcStatus = 1;
		}
		return success;
	}

	async password(password, reset) {
		let success = await this.comm.password(password, reset);
		if (reset && success) {
			this.password = 0;
		} else if (!reset && success) {
			this.password = password;
		}
		return success;
	}

	async readConfiguration() {
		let files = [];

		try {
			// Get descriptor information
			let descriptorBuf = await this.comm.readCode(0x020040, 6);
			
			// Parse descriptors
			let descriptorAddress = descriptorBuf.readUInt32LE();
			let descriptorFiles = descriptorBuf.readUInt16LE(4);
			
			// Each file is described with 46 bytes
			let filesDescriptorBuf = await this.comm.readCode(descriptorAddress, descriptorFiles * this.fileDescriptorSize);
			
			for(let i = 0; i < descriptorFiles; i++) {
				
				let fileDescriptor = filesDescriptorBuf.slice(i * this.fileDescriptorSize, i * this.fileDescriptorSize + this.fileDescriptorSize);
				let zipFile = {
					name: fileDescriptor.slice(0, fileDescriptor.readUInt16LE(32)).toString(),
					address: fileDescriptor.readUInt32LE(34),
					size: fileDescriptor.readUInt32LE(38),
					timestamp: fileDescriptor.readUInt32LE(42)
				}
				
				// Read the file from zip
				let zipContent = await this.comm.readCode(zipFile.address, zipFile.size);
				files = await new Promise(async (resolve, reject) => {
					let files = [];
					
					var zip = new JSZip();
					let contents = await zip.loadAsync(zipContent);
					for(let filename of Object.keys(contents.files)) {
						let content = await zip.file(filename).async('nodebuffer');
						files.push({
							filename: filename,
							content: content
						});
					}
					
					resolve(files);
				});
				
				if (zipFile.name == 'cyp.zip') {
					this._parseProgram(files[0].content.toString());
				} else if (zipFile.name == 'alc.zip') {
					this._parseAlocation(files[0].content.toString());
				}
			}
			
			// Read all values in registry
			// As there is a direct link to the objects in registry the values will be assigned to that object
			let registry = Object.entries(this.registry).map((item) => {
				return item[1];
			});
			await this.read(registry);
		} catch (e) {
			return e;
		}
	}

	_parseProgram(file){
		let controller = this;
		let section = null;
		let sectionOptions = {};
		let lines = file.replace(/[\r]/g, '').split('\n');

		this.sockets = [];
		this.options = {};

		// Remove first line
		lines.shift();

		for(let line of lines) {
			line = line.trim();

			if(line == '#PROJECT_OPTIONS_END'){
				break;
			}

			if (!line.length) {
				continue;
			}

			if(/^\[.+/.test(line)){

				if (/^Socket.+/.test(section)) {
					controller.sockets.push(sectionOptions)
				} else if (section) {
					this.options[section] = sectionOptions;
				}

				section = line.trim().substring(1, line.length-1);
				sectionOptions = {};
			} else {
				sectionOptions[line.split('=')[0]] = line.split('=')[1]
			}
		}
	}

	_parseAlocation(file) {
		// Split by new lines
		let lines = file.replace(/[\r]/g, '').split('\n');
		// Remove first two lines
		lines.shift();
		lines.shift();

		// Filter empty lines
		lines = lines.filter((line) => {
			return line.length;
		});

		// Map line to object
		this.registry = {};
		for(let line of lines){
			let varInfo = line.replace(/  +/g, ' ').split(' ');

			let varObj = {
				address: varInfo.shift(),
				id: varInfo.shift(),
				array: varInfo.shift(),
				offset: varInfo.shift(),
				size: varInfo.shift(),
				scope: varInfo.shift(),
				type: varInfo.shift(),
				name: varInfo.shift(),
				description: varInfo.join(' ')
			};
			this.registry[varObj.name] = varObj;
		}
	}

	_processSocket(frame) {
		let offset = 0;

		// Find the socket
		let socket = this.sockets.find((s) => {
			return frame.socket == parseInt(s.ID);
		});

		if (!socket) {
			console.log(`Socket for frame ${JSON.stringify(frame)} not found`);
			return;
		}

		// Get variable keys
		let keys = Object.keys(socket).filter((v) => {
			return /^Var/.test(v);
		});

		for(let key of keys){
			let type = this.registry[socket[key]].type;
			let size = parseInt(this.registry[socket[key]].size);

			let value = null;

			switch (type) {
				case 'bit':
					value = frame.data.readUInt8(offset);
					break;
				case 'int':
					value = frame.data.readInt16LE(offset);
					break;
				case 'long':
					value = frame.data.readInt32LE(offset);
					break;
				case 'real':
					value = frame.data.readFloatLE(offset);
					break;
			}

			// Add to offset
			offset += size;

			// Check if value has changed
			// TODO check socket type
			if (this.registry[socket[key]].value != value) {
				this.registry[socket[key]].value = value

				// Emit value
				this.emit(`${socket[key]}`, value);
			}
		}
	}
}

module.exports = {
	CybroController
}

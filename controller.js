const { CybroComm } = require('./comm');
const EventEmitter = require('events');
const JSZip = require('jszip');

class CybroController extends EventEmitter {

	nextNad() {
		this.currentNad = this.currentNad && this.currentNad < 4027470283 ? this.currentNad + 1 : 4027370283;
		return this.currentNad;
	}

	constructor(cybro, address, port, nad, password) {
		super();
		
		let controller = this;
		
		// Link parameters
		this.cybro = cybro;
		this.address = address;
		this.port = port;
		this.nad = nad;
		this.password = password;
		
		this.sockets = [];
		this.plcStatus = null;
		this.fileDescriptorSize = 46;

		this.on('frame', (frame) => {
			// Process the socket when socket is not 0
			if (frame.socket != 0) {
				return this._processSocket(frame);
			}
			
			// Direction 1 means it is a response to one of the waiting requests
			if (frame.direction == 1) {
				this.emit(`nad_${frame.nadTo}`, frame);
			}
		});
	}
	
	async ping() {
		let comm = new CybroComm(this, this.address, this.port, this.nextNad(), this.nad, this.password);
		return await comm.ping();
	}

	async status() {
		let comm = new CybroComm(this, this.address, this.port, this.nextNad(), this.nad, this.password);
		this.plcStatus = await comm.status();
		return this.plcStatus;
	}

	async write(variables) {
		if (variables instanceof Array) {
			let comm = new CybroComm(this, this.address, this.port, this.nextNad(), this.nad, this.password);
			return await comm.write(variables);
		} else {
			let comm = new CybroComm(this, this.address, this.port, this.nextNad(), this.nad, this.password);
			return await comm.write([variables]);
		}
	}

	async read(variables) {
		if (variables instanceof Array) {
			let comm = new CybroComm(this, this.address, this.port, this.nextNad(), this.nad, this.password);
			return await comm.read(variables);
		} else {
			let comm = new CybroComm(this, this.address, this.port, this.nextNad(), this.nad, this.password);
			return (await comm.read([variables]))[0];
		}
	}

	async plcStart() {
		let comm = new CybroComm(this, this.address, this.port, this.nextNad(), this.nad, this.password);
		let success = await comm.plcStart();
		if (success) {
			this.plcStatus = 2;
		}
		return success;
	}

	async plcStop() {
		let comm = new CybroComm(this, this.address, this.port, this.nextNad(), this.nad, this.password);
		let success = await comm.plcStop();
		if (success) {
			this.plcStatus = 0;
		}
		return success;
	}

	async plcPause() {
		let comm = new CybroComm(this, this.address, this.port, this.nextNad(), this.nad, this.password);
		let success = await comm.plcPause();
		if (success) {
			this.plcStatus = 1;
		}
		return success;
	}

	async password(password, reset) {
		let comm = new CybroComm(this, this.address, this.port, this.nextNad(), this.nad, this.password);
		let success = await comm.password(password, reset);
		if (reset && success) {
			this.password = 0;
		} else if (!reset && success) {
			this.password = password;
		}
		return success;
	}

	async readConfiguration() {
		let files = [];

		let comm = new CybroComm(this, this.address, this.port, this.nextNad(), this.nad, this.password);

		// Get descriptor information
		let descriptorBuf = await comm.readCode(0x020040, 6);

		// Parse descriptors
		let descriptorAddress = descriptorBuf.readUInt32LE();
		let descriptorFiles = descriptorBuf.readUInt16LE(4);

		// Each file is described with 46 bytes
		let filesDescriptorBuf = await comm.readCode(descriptorAddress, descriptorFiles * this.fileDescriptorSize);

		for(let i = 0; i < descriptorFiles; i++) {

			let fileDescriptor = filesDescriptorBuf.slice(i * this.fileDescriptorSize, i * this.fileDescriptorSize + this.fileDescriptorSize);
			let zipFile = {
				name: fileDescriptor.slice(0, fileDescriptor.readUInt16LE(32)).toString(),
				address: fileDescriptor.readUInt32LE(34),
				size: fileDescriptor.readUInt32LE(38),
				timestamp: fileDescriptor.readUInt32LE(42)
			}

			// Read the file from zip
			let zipContent = await comm.readCode(zipFile.address, zipFile.size);
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
				this.emit(`var_${socket[key]}`, value);
			}
		}
	}
}

module.exports = {
	CybroController
}
const { CybroController } = require('./controller');
const { CybroComm } = require('./comm');
const dgram = require('dgram');
const EventEmitter = require('events');

// Single point where socket is maintained
class Cybro extends EventEmitter {
	constructor(port) {
		super();

		this.port = port;
		this.controllers = [];

	}

	async addController(address, nad, password) {
		// Check if controller object has already been created
		let controller = this.controllers.find((controller) => {
			return controller.address == address;
		});
		
		// Return existing controller if it exist
		if (controller) {
			return controller;
		}
		
		// Create new controller object when 
		controller = new CybroController(address, this.port, nad, password);

		// Connect with controller
		await controller.connect();

		// Add to the list of controllers
		this.controllers.push(controller);

		// Run configuration on the controller
		console.log(`Controler ${controller.address} - ${controller.nad}: Reading controller configuration`);
		await controller.readConfiguration();
		console.log(`Controler ${controller.address} - ${controller.nad}: DONE Reading controller configuration`);

		// Return new controller
		return controller;
	}

	async autodetect(port) {
		// Autodetect Cybro controllers
		let controllers = await CybroComm.autodetect(port);

		// Return list of controllers
		return controllers;
	}
}

module.exports = {
	Cybro
}
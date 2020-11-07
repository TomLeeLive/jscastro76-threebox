/**
 * @author peterqliu / https://github.com/peterqliu
 * @author jscastro / https://github.com/jscastro76
 */

const THREE = require("./three.js");
const CameraSync = require("./camera/CameraSync.js");
const utils = require("./utils/utils.js");
const SunCalc = require("./utils/suncalc.js");
const AnimationManager = require("./animation/AnimationManager.js");
const ThreeboxConstants = require("./utils/constants.js");
const Objects = require("./objects/objects.js");
const material = require("./utils/material.js");
const sphere = require("./objects/sphere.js");
const label = require("./objects/label.js");
const tooltip = require("./objects/tooltip.js");
const loader = require("./objects/loadObj.js");
const Object3D = require("./objects/Object3D.js");
const line = require("./objects/line.js");
const tube = require("./objects/tube.js");
const LabelRenderer = require("./objects/LabelRenderer.js");
const BuildingShadows = require("./objects/effects/BuildingShadows.js");

function Threebox(map, glContext, options){

    this.init(map, glContext, options);

};

Threebox.prototype = {

	repaint: function () {
		this.map.repaint = true;
	},

	/**
	 * Threebox constructor init method
	 * @param {mapboxgl.map} map
	 * @param {WebGLRenderingContext} glContext
	 * @param {defaultOptions} options
	 */
	init: function (map, glContext, options) {

		// apply starter options
		this.options = utils._validate(options || {}, defaultOptions);

		this.map = map;
		this.map.tb = this; //[jscastro] needed if we want to queryRenderedFeatures from map.onload

		this.objects = new Objects();

		// Set up a THREE.js scene
		this.renderer = new THREE.WebGLRenderer({
			alpha: true,
			antialias: true,
			//preserveDrawingBuffer: true,
			canvas: map.getCanvas(),
			context: glContext
		});

		this.renderer.setPixelRatio(window.devicePixelRatio);
		this.renderer.setSize(this.map.getCanvas().clientWidth, this.map.getCanvas().clientHeight);
		this.renderer.outputEncoding = THREE.sRGBEncoding;
		this.renderer.autoClear = false;

		// [jscastro] set labelRendered
		this.labelRenderer = new LabelRenderer(this.map);

		this.scene = new THREE.Scene();
		this.camera = new THREE.PerspectiveCamera(ThreeboxConstants.FOV_DEGREES, this.map.getCanvas().clientWidth / this.map.getCanvas().clientHeight, 1, 1e21);
		this.camera.layers.enable(0);
		this.camera.layers.enable(1);

		// The CameraSync object will keep the Mapbox and THREE.js camera movements in sync.
		// It requires a world group to scale as we zoom in. Rotation is handled in the camera's
		// projection matrix itself (as is field of view and near/far clipping)
		// It automatically registers to listen for move events on the map so we don't need to do that here
		this.world = new THREE.Group();
		this.world.name = "world";
		this.scene.add(this.world);

		this.objectsCache = new Map();
		
		this.cameraSync = new CameraSync(this.map, this.camera, this.world);

		//raycaster for mouse events
		this.raycaster = new THREE.Raycaster();
		this.raycaster.layers.set(0);
		//this.raycaster.params.Points.threshold = 100;

		this.mapCenter = this.map.getCenter();
		this.mapCenterUnits = utils.projectToWorld([this.mapCenter.lng, this.mapCenter.lat]);
		this.lightDateTime = new Date();
		this.lightLng = this.mapCenter.lng;
		this.lightLat = this.mapCenter.lat;
		this.sunPosition;

		this.lights = this.initLights;
		if (this.options.defaultLights) this.defaultLights();
		if (this.options.realSunlight) this.realSunlight();
		if (this.options.enableSelectingFeatures) this.enableSelectingFeatures = this.options.enableSelectingFeatures;
		if (this.options.enableSelectingObjects) this.enableSelectingObjects = this.options.enableSelectingObjects;
		if (this.options.enableDraggingObjects) this.enableDraggingObjects = this.options.enableDraggingObjects;
		if (this.options.enableRotatingObjects) this.enableRotatingObjects = this.options.enableRotatingObjects;
		if (this.options.enableTooltips) this.enableTooltips = this.options.enableTooltips;

		//[jscastro] new event map on load
		this.map.on('load', function () {

			//[jscastro] new fields to manage events on map
			let selectedObject; //selected object through click
			let draggedObject; //dragged object through mousedown + mousemove
			let draggedAction; //dragged action to notify frontend
			let overedObject; //overed object through mouseover

			let overedFeature;//overed state for extrusion layer features
			let selectedFeature;//selected state id for extrusion layer features

			let canvas = this.getCanvasContainer();
			this.getCanvasContainer().style.cursor = 'default';
			// Variable to hold the starting xy coordinates
			// when 'mousedown' occured.
			let start;
			let rotationStep = 10;// degrees step size for rotation
			let gridStep = 6;// decimals to adjust the lnglat

			//when object selected
			let startCoords = [];

			// Variable to hold the current xy coordinates
			// when 'mousemove' or 'mouseup' occurs.
			let current;

			// Variable for the draw box element.
			let box;

			let lngDiff; // difference between cursor and model left corner
			let latDiff; // difference between cursor and model bottom corner

			// Return the xy coordinates of the mouse position
			function mousePos(e) {
				var rect = canvas.getBoundingClientRect();
				return new mapboxgl.Point(
					e.originalEvent.clientX - rect.left - canvas.clientLeft,
					e.originalEvent.clientY - rect.top - canvas.clientTop
				);
			}

			function unselectFeature(f, map) {
				if (typeof f.id == 'undefined') return;
				map.setFeatureState(
					{ source: f.source, sourceLayer: f.sourceLayer, id: f.id },
					{ select: false }
				);

				removeTooltip(f, map);
				f = map.queryRenderedFeatures({ layers: [f.layer.id], filter: ["==", ['id'], f.id] })[0];
				// Dispatch new event f for unselected
				if (f) map.fire('SelectedFeatureChange', { detail: f });
				selectedFeature = null;

			}

			function selectFeature(f, map) {
				selectedFeature = f;
				map.setFeatureState(
					{ source: selectedFeature.source, sourceLayer: selectedFeature.sourceLayer, id: selectedFeature.id },
					{ select: true }
				);
				selectedFeature = map.queryRenderedFeatures({ layers: [selectedFeature.layer.id], filter: ["==", ['id'], selectedFeature.id] })[0];
				addTooltip(selectedFeature, map)
				// Dispatch new event SelectedFeature for selected
				map.fire('SelectedFeatureChange', { detail: selectedFeature });

			}

			function unoverFeature(f, map) {
				if (overedFeature && typeof overedFeature != 'undefined' && overedFeature.id != f) {
					map.setFeatureState(
						{ source: overedFeature.source, sourceLayer: overedFeature.sourceLayer, id: overedFeature.id },
						{ hover: false }
					);
					removeTooltip(overedFeature, map);
					overedFeature = null;
				}
			}

			function unselectObject(o) {
				//deselect, reset and return
				o.selected = false;
				selectedObject = null;
			}

			function addTooltip(f, map) {
				if (!map.tb.enableTooltips) return;
				let coordinates = map.tb.getFeatureCenter(f);
				let t = map.tb.tooltip({
					text: f.properties.name || f.id || f.type,
					mapboxStyle: true,
					feature: f
				});
				t.setCoords(coordinates);
				map.tb.add(t);
				f.tooltip = t;
				f.tooltip.tooltip.visible = true;
			}

			function removeTooltip(f, map) {
				if (f.tooltip) {
					f.tooltip.visibility = false;
					map.tb.remove(f.tooltip);
					f.tooltip = null;
				}
			}

			map.onContextMenu = function (e) {
				alert('contextMenu'); //TODO: implement a callback
			}

			// onclick function
			map.onClick = function (e) {
				let intersectionExists
				let intersects = [];
				if (map.tb.enableSelectingObjects) {
					//raycast only if we are in a custom layer, for other layers go to the else, this avoids duplicated calls to raycaster
					intersects = this.tb.queryRenderedFeatures(e.point);
				}
				intersectionExists = typeof intersects[0] == 'object';
				// if intersect exists, highlight it
				if (intersectionExists) {

					let nearestObject = Threebox.prototype.findParent3DObject(intersects[0]);

					if (nearestObject) {
						//if extrusion object selected, unselect
						if (selectedFeature) {
							unselectFeature(selectedFeature, this);
						}
						//if not selected yet, select it
						if (!selectedObject) {
							selectedObject = nearestObject;
							selectedObject.selected = true;
						}
						else if (selectedObject.uuid != nearestObject.uuid) {
							//it's a different object, restore the previous and select the new one
							selectedObject.selected = false;
							nearestObject.selected = true;
							selectedObject = nearestObject;

						} else if (selectedObject.uuid == nearestObject.uuid) {
							//deselect, reset and return
							unselectObject(selectedObject);
							return;
						}

						// fire the Wireframed event to notify UI status change
						selectedObject.dispatchEvent(new CustomEvent('Wireframed', { detail: selectedObject, bubbles: true, cancelable: true }));
						selectedObject.dispatchEvent(new CustomEvent('IsPlayingChanged', { detail: selectedObject, bubbles: true, cancelable: true }));

						this.repaint = true;
						e.preventDefault();
					}
				}
				else {
					let features = [];
					if (map.tb.enableSelectingFeatures) {
						features = this.queryRenderedFeatures(e.point);
					}
					//now let's check the extrusion layer objects
					if (features.length > 0) {

						if (features[0].layer.type == 'fill-extrusion' && typeof features[0].id != 'undefined') {

							//if 3D object selected, unselect
							if (selectedObject) {
								unselectObject(selectedObject);
							}

							//if not selected yet, select it
							if (!selectedFeature) {
								selectFeature(features[0], this)
							}
							else if (selectedFeature.id != features[0].id) {
								//it's a different feature, restore the previous and select the new one
								unselectFeature(selectedFeature, this);
								selectFeature(features[0], this)

							} else if (selectedFeature.id == features[0].id) {
								//deselect, reset and return
								unselectFeature(selectedFeature, this);
								return;
							}

						}
					}
				}
			}

			map.onMouseMove = function (e) {
				// Capture the ongoing xy coordinates
				let current = mousePos(e);

				this.getCanvasContainer().style.cursor = 'default';
				//check if being rotated
				if (e.originalEvent.altKey && draggedObject) {

					if (!map.tb.enableRotatingObjects) return;
					draggedAction = 'rotate';
					// Set a UI indicator for dragging.
					this.getCanvasContainer().style.cursor = 'move';
					var minX = Math.min(start.x, current.x),
						maxX = Math.max(start.x, current.x),
						minY = Math.min(start.y, current.y),
						maxY = Math.max(start.y, current.y);
					//set the movement fluid we rotate only every 10px moved, in steps of 10 degrees up to 360
					let rotation = { x: 0, y: 0, z: 360 + ((~~((current.x - start.x) / rotationStep) % 360 * rotationStep) % 360) };
					//now rotate the model depending the axis
					draggedObject.setRotation(rotation);
					//draggedObject.setRotationAxis(rotation);
					return;
				}

				//check if being moved
				if (e.originalEvent.shiftKey && draggedObject) {
					if (!map.tb.enableDraggingObjects) return;

					draggedAction = 'translate';
					// Set a UI indicator for dragging.
					this.getCanvasContainer().style.cursor = 'move';
					// Capture the first xy coordinates, height must be the same to move on the same plane
					let coords = e.lngLat;
					let options = [Number((coords.lng + lngDiff).toFixed(gridStep)), Number((coords.lat + latDiff).toFixed(gridStep)), draggedObject.modelHeight];
					draggedObject.setCoords(options);
					return;
				}

				let intersectionExists
				let intersects = [];

				if (map.tb.enableSelectingObjects) {
					// calculate objects intersecting the picking ray
					intersects = this.tb.queryRenderedFeatures(e.point);
				}
				intersectionExists = typeof intersects[0] == 'object';

				// if intersect exists, highlight it, if not check the extrusion layer
				if (intersectionExists) {
					let nearestObject = Threebox.prototype.findParent3DObject(intersects[0]);
					if (nearestObject) {
						unoverFeature(overedFeature, this);
						this.getCanvasContainer().style.cursor = 'pointer';
						if (!selectedObject || nearestObject.uuid != selectedObject.uuid) {
							if (overedObject) {
								overedObject.over = false;
								overedObject = null;
							}
							nearestObject.over = true;
							overedObject = nearestObject;
						}
						this.repaint = true;
						e.preventDefault();
					}
				}
				else {
					//clean the object overed
					if (overedObject) { overedObject.over = false; overedObject = null; }
					//now let's check the extrusion layer objects
					let features = [];
					if (map.tb.enableSelectingFeatures) {
						features = this.queryRenderedFeatures(e.point);
					}
					if (features.length > 0) {
						unoverFeature(features[0], this);

						if (features[0].layer.type == 'fill-extrusion' && typeof features[0].id != 'undefined') {
							if ((!selectedFeature || selectedFeature.id != features[0].id)) {
								this.getCanvasContainer().style.cursor = 'pointer';
								overedFeature = features[0];
								this.setFeatureState(
									{ source: overedFeature.source, sourceLayer: overedFeature.sourceLayer, id: overedFeature.id },
									{ hover: true }
								);
								overedFeature = map.queryRenderedFeatures({ layers: [overedFeature.layer.id], filter: ["==", ['id'], overedFeature.id] })[0];
								addTooltip(overedFeature, this);

							}
						}
					}
				}

			}

			map.onMouseDown = function (e) {

				// Continue the rest of the function shiftkey or altkey are pressed, and if object is selected
				if (!((e.originalEvent.shiftKey || e.originalEvent.altKey) && e.originalEvent.button === 0 && selectedObject)) return;

				e.preventDefault();

				map.getCanvasContainer().style.cursor = 'move';

				// Disable default drag zooming when the shift key is held down.
				//map.dragPan.disable();

				// Call functions for the following events
				map.once('mouseup', map.onMouseUp);
				map.once('mouseout', map.onMouseUp);

				// move the selected object
				draggedObject = selectedObject;

				// Capture the first xy coordinates
				start = mousePos(e);
				startCoords = draggedObject.coordinates;
				lngDiff = startCoords[0] - e.lngLat.lng;
				latDiff = startCoords[1] - e.lngLat.lat;
			}

			map.onMouseUp = function (e) {

				// Set a UI indicator for dragging.
				this.getCanvasContainer().style.cursor = 'default';

				// Remove these events now that finish has been called.
				//map.off('mousemove', onMouseMove);
				this.off('mouseup', map.onMouseUp);
				this.off('mouseout', map.onMouseUp);
				this.dragPan.enable();

				if (draggedObject) {
					draggedObject.dispatchEvent(new CustomEvent('ObjectDragged', { detail: { draggedObject: draggedObject, draggedAction: draggedAction }, bubbles: true, cancelable: true }));

					draggedObject = null;
					draggedAction = null;
				};
			}

			map.onMouseOut = function (e) {
				if (overedFeature) {
					let features = this.queryRenderedFeatures(e.point);
					if (features.length > 0 && overedFeature.id != features[0].id) {
						this.getCanvasContainer().style.cursor = 'default';
						//only unover when new feature is another
						unoverFeature(features[0], this);
					}
				}
			}

			//listener to the events
			//this.on('contextmenu', map.onContextMenu);
			this.on('click', map.onClick);
			this.on('mousemove', map.onMouseMove);
			this.on('mouseout', map.onMouseOut)
			this.on('mousedown', map.onMouseDown);

		});

	},

	// Objects
	sphere: function (options) {
		this.setDefaultView(options, this.options);
		return sphere(options, this.world)
	},

	line: line,

	label: label,

	tooltip: tooltip,

	tube: function (options) {
		this.setDefaultView(options, this.options);
		return tube(options, this.world)
	},

	Object3D: function (options, o) {
		this.setDefaultView(options, this.options);
		return Object3D(options, o)
	},

	loadObj: async function loadObj(options, cb) {
		this.setDefaultView(options, this.options);
		//[jscastro] new added cache for 3D Objects
		let cache = this.objectsCache.get(options.obj);
		if (cache) {
			cache.promise
				.then(obj => {
					//console.log("Cloning " + options.obj);
					cb(obj.duplicate(options));
				})
				.catch(err => {
					this.objectsCache.delete(options.obj);
					console.error("Could not load model file: " + options.obj);
				});
		} else {
			this.objectsCache.set(options.obj, {
				promise: new Promise(
					function (resolve, reject) {
						loader(options, cb, function (obj) {
							//console.log("Loading " + options.obj);
							if (obj.duplicate) {
								resolve(obj.duplicate());
							} else {
								reject(obj);
							}
						});
					})
			});

		}
	},

	// Material

	material: function (o) {
		return material(o)
	},

	initLights : {
		ambientLight: null,
		dirLight: null,
		dirLightBack: null,
		dirLightHelper: null,
		hemiLight: null,
		pointLight: null
	},

	utils: utils,

	SunCalc: SunCalc,

	Constants: ThreeboxConstants,

	projectToWorld: function (coords) {
		return this.utils.projectToWorld(coords)
	},

	unprojectFromWorld: function (v3) {
		return this.utils.unprojectFromWorld(v3)
	},

	projectedUnitsPerMeter: function (lat) {
		return this.utils.projectedUnitsPerMeter(lat)
	},

	//get the center point of a feature
	getFeatureCenter: function getFeatureCenter(feature, obj, level) {
		return utils.getFeatureCenter(feature, obj, level);
	},

	getObjectHeightOnFloor: function (feature, obj, level) {
		return utils.getObjectHeightOnFloor(feature, obj, level);
	},

	queryRenderedFeatures: function (point) {

		let mouse = new THREE.Vector2();

		// // scale mouse pixel position to a percentage of the screen's width and height
		mouse.x = (point.x / this.map.transform.width) * 2 - 1;
		mouse.y = 1 - (point.y / this.map.transform.height) * 2;

		this.raycaster.setFromCamera(mouse, this.camera);

		// calculate objects intersecting the picking ray
		let intersects = this.raycaster.intersectObjects(this.world.children, true);

		return intersects
	},

	//[jscastro] find 3D object of a mesh. this method is needed to know the object of a raycasted mesh
	findParent3DObject: function (mesh) {
		//find the Parent Object3D of the mesh captured by Raytracer
		var result;
		mesh.object.traverseAncestors(function (m) {
			if (m.parent)
				if (m.parent.type == "Group" && m.userData.obj) {
					result = m;
				}
		});
		return result;
	},

	//[jscastro] method set the CSS2DObjects zoom range and hide them at the same time the layer is
	setLabelZoomRange: function (minzoom, maxzoom) {
		this.labelRenderer.setZoomRange(minzoom, maxzoom);
	},

	//[jscastro] method to replicate behaviour of map.setLayoutProperty when Threebox are affected
	setLayoutProperty: function (layerId, name, value) {
		//first set layout property at the map
		this.map.setLayoutProperty(layerId, name, value);
		if (value !== null && value !== undefined) {
			if (name === 'visibility') {
				this.world.children.forEach(function (obj) {
					if (obj.userData.feature && obj.userData.feature.layer === layerId) {
						obj.visibility = value;
					}
				});
				return;
			}
		}
	},

	//[jscastro] Custom Layers doesn't work on minzoom and maxzoom attributes, and if the layer is including labels they don't hide either on minzoom
	setLayerZoomRange: function (layer3d, minZoomLayer, maxZoomLayer) {
		if (this.map.getLayer(layer3d)) {
			this.map.setLayerZoomRange(layer3d, minZoomLayer, maxZoomLayer)
			this.setLabelZoomRange(minZoomLayer, maxZoomLayer);
		}
	},

	//[jscastro] method to set the height of all the objects in a level. this only works if the objects have a geojson feature
	setLayerHeigthProperty: function (layerId, level) {
		let layer = this.map.getLayer(layerId);
		if (!layer) return;
		if (layer.type == "fill-extrusion") {
			let data = this.map.getStyle().sources[layer.source].data;
			let features = data.features;
			features.forEach(function (f) {
				f.properties.level = level;
			});
			//we change the level on the source
			this.map.getSource(layer.source).setData(data);
		} else if (layer.type == "custom") {
			this.world.children.forEach(function (obj) {
				let feature = obj.userData.feature;
				if (feature && feature.layer === layerId) {
					//TODO: this could be a multidimensional array
					let location = this.tb.getFeatureCenter(feature, obj, level);
					obj.setCoords(location);
				}
			});
		}
	},

	//[jscastro] mapbox setStyle removes all the layers, including custom layers, so tb.world must be cleaned up too
	setStyle: function (styleId, options) {
		this.clear().then(() => {
			this.map.setStyle(styleId, options);
		});
	},

	//[jscastro] method to toggle Layer visibility
	toggleLayer: function (layerId, visible) {
		if (this.map.getLayer(layerId)) {
			//call
			this.setLayoutProperty(layerId, 'visibility', (visible ? 'visible' : 'none'))
		};
	},

	update: function () {

		if (this.map.repaint) this.map.repaint = false

		var timestamp = Date.now();

		// Update any animations
		this.objects.animationManager.update(timestamp);

		this.updateLightHelper();

		// Render the scene and repaint the map
		this.renderer.state.reset();
		this.renderer.render(this.scene, this.camera);

		// [jscastro] Render any label
		this.labelRenderer.render(this.scene, this.camera);

		if (this.options.passiveRendering === false) this.map.triggerRepaint();
	},

	add: function (obj) {
		//[jscastro] remove the tooltip if not enabled
		if (!this.enableTooltips && obj.tooltip) { obj.tooltip.visibility = false };
		this.world.add(obj);
	},

	remove: function (obj) {
		if (obj.dispose) obj.dispose();
		this.world.remove(obj);
		obj = null;
	},

	//[jscastro] this clears tb.world in order to dispose properly the resources
	clear: async function (layerId = null, dispose = false) {
		return new Promise((resolve, reject) => {
			let objects = [];
			this.world.children.forEach(function (object) {
				objects.push(object);
			});
			for (let i = 0; i < objects.length; i++) {
				let obj = objects[i];
				//if layerId, check the layer to remove, otherwise always remove
				if ((layerId && obj.userData.feature.layer === layerId) || !layerId) {
					this.remove(obj);
				}
			}
			if (dispose) {
				this.objectsCache.forEach((value) => {
					value.promise.then(obj => {
						obj.dispose();
						obj = null;
					})
				})
			}

			resolve("clear");
		});
	},

	//[jscastro] remove a layer clearing first the 3D objects from this layer in tb.world
	removeLayer: function (layerId) {
		this.clear(layerId, true).then( () => {
			this.map.removeLayer(layerId);
		});
	},

	//[jscastro] get the sun position (azimuth, altitude) from a given datetime, lng, lat
	getSunPosition: function (date, lng, lat) {
		return SunCalc.getPosition(date, lat, lng);  
	},

	//[jscastro] set shadows for fill-extrusion layers
	setBuildingShadows: function (options) {
		if (this.map.getLayer(options.buildingsLayerId)) {
			let layer = new BuildingShadows(options, this);
			this.map.addLayer(layer, options.buildingsLayerId);
		}
		else {
			console.warn("The layer '" + options.buildingsLayerId + "' does not exist in the map.");
		}
	},

	//[jscastro] This method set the sun light for a given datetime and lnglat
	setSunlight: function (newDate = new Date(), coords) {
		if (!this.lights.dirLight || !this.options.realSunlight) {
			console.warn("To use setSunlight it's required to set realSunlight : true in Threebox initial options.");
			return;
		}

		var date = new Date(newDate.getTime());

		if (coords) {
			this.mapCenter = { lng: coords[0], lat: coords[1] };
		}
		else {
			this.mapCenter = this.map.getCenter();
		}

		if (this.lightDateTime && this.lightDateTime.getTime() === date.getTime() && this.lightLng === this.mapCenter.lng && this.lightLat === this.mapCenter.lat) {
			return; //setSunLight could be called on render, so due to performance, avoid duplicated calls
		}

		this.lightDateTime = date;
		this.lightLng = this.mapCenter.lng; 
		this.lightLat = this.mapCenter.lat
		this.sunPosition = this.getSunPosition(date, this.mapCenter.lng, this.mapCenter.lat);  
		let altitude = this.sunPosition.altitude;
		let azimuth = Math.PI + this.sunPosition.azimuth;
		//console.log("Altitude: " + utils.degreeify(altitude) + ", Azimuth: " + (utils.degreeify(azimuth)));

		let radius = ThreeboxConstants.WORLD_SIZE / 2;
		let alt = Math.sin(altitude);
		let altRadius = Math.cos(altitude);
		let azCos = Math.cos(azimuth) * altRadius;
		let azSin = Math.sin(azimuth) * altRadius;

		this.lights.dirLight.position.set(azSin, azCos, alt);
		this.lights.dirLight.position.multiplyScalar(radius);
		this.lights.dirLight.intensity = Math.max(alt, -0.15);
		//this.lights.hemiLight.intensity = alt * 0.6;
		//console.log("Intensity:" + this.lights.dirLight.intensity);
		this.lights.dirLight.updateMatrixWorld();
		this.updateLightHelper();
		if (this.map.loaded()) {
			this.map.setLight({
				anchor: 'map',
				position: [1.5, 180 + this.sunPosition.azimuth * 180 / Math.PI, 90 - this.sunPosition.altitude * 180 / Math.PI],
				'position-transition': { duration: 0 },
				//color: '#fdb'
				color: `hsl(40, ${50 * Math.cos(this.sunPosition.altitude)}%, ${96 * Math.sin(this.sunPosition.altitude)}%)`
			}, { duration: 0 });
			//console.log(pos.altitude);
		}
	},

	//[jscastro] this updates the directional light helper
	updateLightHelper: function () {
		if (this.lights.dirLightHelper) {
			this.lights.dirLightHelper.position.setFromMatrixPosition(this.lights.dirLight.matrixWorld);
			this.lights.dirLightHelper.updateMatrix();
			this.lights.dirLightHelper.update();
		}
	},

	//[jscastro] method to fully dispose the resources, watch out is you call this without navigating to other page
	dispose: async function () {

		console.log(this.memory());
		//console.log(window.performance.memory);

		return new Promise((resolve) => {
			resolve(
				this.clear(null, true).then((resolve) => {
					this.map.remove();
					this.map = {};
					this.scene.remove(this.world);
					this.scene.dispose();
					this.world.children = [];
					this.world = null;
					this.objectsCache.clear();
					this.labelRenderer.dispose();
					console.log(this.memory());
					this.renderer.dispose();
					return resolve;
				})
			);
			//console.log(window.performance.memory);
		});

	},

	defaultLights: function () {

		this.lights.ambientLight = new THREE.AmbientLight(new THREE.Color('hsl(0, 0%, 100%)'), 0.75);
		this.scene.add(this.lights.ambientLight);

		this.lights.dirLightBack = new THREE.DirectionalLight(new THREE.Color('hsl(0, 0%, 100%)'), 0.25);
		this.lights.dirLightBack.position.set(30, 100, 100);
		this.scene.add(this.lights.dirLightBack);

		this.lights.dirLight  = new THREE.DirectionalLight(new THREE.Color('hsl(0, 0%, 100%)'), 0.25);
		this.lights.dirLight.position.set(-30, 100, -100);
		this.scene.add(this.lights.dirLight);

	},

	realSunlight: function () {

		this.renderer.shadowMap.enabled = true;
		//this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		this.lights.dirLight = new THREE.DirectionalLight(0xffffff, 1);
		this.scene.add(this.lights.dirLight);
		this.lights.dirLightHelper = new THREE.DirectionalLightHelper(this.lights.dirLight, 5);
		this.scene.add(this.lights.dirLightHelper);
		let d2 = 1000; let r2 = 2; let mapSize2 = 8192;
		this.lights.dirLight.castShadow = true;
		this.lights.dirLight.shadow.radius = r2;
		this.lights.dirLight.shadow.mapSize.width = mapSize2;
		this.lights.dirLight.shadow.mapSize.height = mapSize2;
		this.lights.dirLight.shadow.camera.top = this.lights.dirLight.shadow.camera.right = d2;
		this.lights.dirLight.shadow.camera.bottom = this.lights.dirLight.shadow.camera.left = -d2;
		this.lights.dirLight.shadow.camera.near = 1;
		this.lights.dirLight.shadow.camera.visible = true;
		this.lights.dirLight.shadow.camera.far = 400000000; 

		this.lights.hemiLight = new THREE.HemisphereLight(new THREE.Color(0xffffff), new THREE.Color(0xffffff), 0.6);
		this.lights.hemiLight.color.setHSL(0.661, 0.96, 0.12);
		this.lights.hemiLight.groundColor.setHSL(0.11, 0.96, 0.14);
		this.lights.hemiLight.position.set(0, 0, 50);
		this.scene.add(this.lights.hemiLight);
		this.setSunlight();

	},

	setDefaultView: function (options, defOptions) {
		options.bbox = options.bbox || defOptions.enableSelectingObjects;
		options.tooltip = options.tooltip || defOptions.enableTooltips;
	},

	memory: function () { return this.renderer.info.memory },

	programs: function () { return this.renderer.info.programs.length },

	version: '2.0.7',

}

var defaultOptions = {
	defaultLights: false,
	realSunlight: false,
	passiveRendering: true,
	enableSelectingFeatures: false,
	enableSelectingObjects: false,
	enableDraggingObjects: false,
	enableRotatingObjects: false,
	enableTooltips: false
}
module.exports = exports = Threebox;


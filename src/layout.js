import HitBox from './hitbox';
import utils from './utils';

function coordinates(view, model, geometry) {
	var point = model.positioner(view, model);
	var vx = point.vx;
	var vy = point.vy;

	if (!vx && !vy) {
		// if aligned center, we don't want to offset the center point
		return {x: point.x, y: point.y};
	}

	var w = geometry.w;
	var h = geometry.h;

	// take in account the label rotation
	var rotation = model.rotation;
	var dx = Math.abs(w / 2 * Math.cos(rotation)) + Math.abs(h / 2 * Math.sin(rotation));
	var dy = Math.abs(w / 2 * Math.sin(rotation)) + Math.abs(h / 2 * Math.cos(rotation));

	// scale the unit vector (vx, vy) to get at least dx or dy equal to
	// w or h respectively (else we would calculate the distance to the
	// ellipse inscribed in the bounding rect)
	var vs = 1 / Math.max(Math.abs(vx), Math.abs(vy));
	dx *= vx * vs;
	dy *= vy * vs;

	// finally, include the explicit offset
	dx += model.offset * vx;
	dy += model.offset * vy;

	return {
		x: point.x + dx,
		y: point.y + dy
	};
}

function collide(labels, collider) {
	var i, j, s0, s1;

	// IMPORTANT Iterate in the reverse order since items at the end of the
	// list have an higher weight/priority and thus should be less impacted
	// by the overlapping strategy.

	for (i = labels.length - 1; i >= 0; --i) {
		s0 = labels[i].$layout;

		for (j = i - 1; j >= 0 && s0._visible; --j) {
			s1 = labels[j].$layout;

			if (s1._visible && s0._box.intersects(s1._box)) {
				collider(s0, s1);
			}
		}
	}

	return labels;
}

function compute(labels) {
	var i, ilen, label, state, geometry, center;

	// Initialize labels for overlap detection
	for (i = 0, ilen = labels.length; i < ilen; ++i) {
		label = labels[i];
		state = label.$layout;

		if (state._visible) {
			geometry = label.geometry();
			center = coordinates(label._el._model, label.model(), geometry);
			state._box.update(center, geometry, label.rotation());
		}
	}

	// Auto hide overlapping labels
	return collide(labels, function(s0, s1) {
		var h0 = s0._hidable;
		var h1 = s1._hidable;

		if ((h0 && h1) || h1) {
			s1._visible = false;
		} else if (h0) {
			s0._visible = false;
		}
	});
}

export default {
	prepare: function(datasets) {
		var labels = [];
		var i, j, ilen, jlen, label;

		for (i = 0, ilen = datasets.length; i < ilen; ++i) {
			for (j = 0, jlen = datasets[i].length; j < jlen; ++j) {
				label = datasets[i][j];
				labels.push(label);
				label.$layout = {
					_box: new HitBox(),
					_hidable: false,
					_visible: true,
					_set: i,
					_idx: j
				};
			}
		}

		// TODO New `z` option: labels with a higher z-index are drawn
		// of top of the ones with a lower index. Lowest z-index labels
		// are also discarded first when hiding overlapping labels.
		labels.sort(function(a, b) {
			var sa = a.$layout;
			var sb = b.$layout;

			return sa._idx === sb._idx
				? sb._set - sa._set
				: sb._idx - sa._idx;
		});

		this.update(labels);

		return labels;
	},

	update: function(labels) {
		var dirty = false;
		var i, ilen, label, model, state;

		for (i = 0, ilen = labels.length; i < ilen; ++i) {
			label = labels[i];
			model = label.model();
			state = label.$layout;
			state._hidable = model && model.display === 'auto';
			state._visible = label.visible();
			dirty |= state._hidable;
		}

		if (dirty) {
			compute(labels);
		}
	},

	lookup: function(labels, point) {
		var i, state;

		// IMPORTANT Iterate in the reverse order since items at the end of
		// the list have an higher z-index, thus should be picked first.

		for (i = labels.length - 1; i >= 0; --i) {
			state = labels[i].$layout;

			if (state && state._visible && state._box.contains(point)) {
				return labels[i];
			}
		}

		return null;
	},
	/*
	 * Adjusts label positions so that there is no vertical overlap. For vertical bars.
	 * It generally moves labels towards bottom, but makes sure they don't go too low
	 */
	adjustForNoOverlap: function(label, centers, center, itemsPerSeries, maxGraphHeight, numberOfVisibleDatasets) {
		var state = label.$layout;

		centers[state._idx] = centers[state._idx] || []
		itemsPerSeries[state._idx] = itemsPerSeries[state._idx] || 0

		var previousCenter = centers[state._idx].slice(-1).pop();
		var requiredHeight = (numberOfVisibleDatasets[state._idx] - itemsPerSeries[state._idx] - 1) * label._rects.text.h;

		var requiredDiff = center.y - maxGraphHeight + requiredHeight;
		if (requiredDiff > 0) {
			// make sure labels don't go under bottom
			center.yDiff = -requiredDiff;
			center.y += -requiredDiff;
		} else if (previousCenter) {
			var diff = center.y - previousCenter.y - label._rects.text.h;
			if (diff < 0) {
				// adjust y and remember difference so original height is available
				center.yDiff = -diff;
				center.y += -diff;
			}
		}

		// make sure first item is not too high. because it gets clipped
		if (center.y < label._rects.text.h / 2) {
			const diff = -center.y + label._rects.text.h / 2;
			center.yDiff = diff;
			center.y += diff;
		}

		centers[state._idx].push(center);
		itemsPerSeries[state._idx] += 1;
	},

	getNumberOfVisibleDatasets: function(labels) {
		return Object.entries(utils.groupBy(labels.map(label => label.$layout).filter(label => label._visible), '_idx')).reduce((acc, entry) => {
			acc[entry[0]] = entry[1].length
			return acc
		}, {})
	},

	draw: function(chart, labels) {
		var i, ilen, label, state, geometry, center;
		var centers = {}, itemsPerSeries = {}, maxGraphHeight, numberOfVisibleDatasets;

		for (i = 0, ilen = labels.length; i < ilen; ++i) {
			label = labels[i];
			state = label.$layout;

			if (state._visible) {
				geometry = label.geometry();
				center = coordinates(label._el._view, label.model(), geometry);

				if (label._model.noOverlap === true) {
					if (!maxGraphHeight /* calculate only once per draw */) {
						maxGraphHeight = Math.max(...labels.map(label => label._el._view.y));
						numberOfVisibleDatasets = this.getNumberOfVisibleDatasets(labels)
					}

					this.adjustForNoOverlap(label, centers, center, itemsPerSeries, maxGraphHeight, numberOfVisibleDatasets)
				}

				state._box.update(center, geometry, label.rotation());
				label.draw(chart, center);
			}
		}
	}
};

const cheerio = require('cheerio');
const htmlparser = require('htmlparser2'); require('../patches/htmlparser2');
const Promise = require('bluebird');
const slugify = require('@sindresorhus/slugify');

const _ = {};
_.isArray = require('lodash/isArray');
_.has = require('lodash/has');

const md = require('../lib/markdown-it');
const utils = require('../utils');
const logger = require('../utils/logger');

const {
  ATTRIB_CWF,
} = require('../constants');

cheerio.prototype.options.decodeEntities = false; // Don't escape HTML entities

class ComponentParser {
  constructor(config) {
    this.config = config;
  }

  /*
   * Private utility functions
   */

  static _trimNodes(node) {
    if (node.name === 'pre' || node.name === 'code') {
      return;
    }
    if (node.children) {
      for (let n = 0; n < node.children.length; n += 1) {
        const child = node.children[n];
        if (child.type === 'comment'
          || (child.type === 'text' && n === node.children.length - 1 && !/\S/.test(child.data))) {
          node.children.splice(n, 1);
          n -= 1;
        } else if (child.type === 'tag') {
          ComponentParser._trimNodes(child);
        }
      }
    }
  }

  static _isText(node) {
    return node.type === 'text' || node.type === 'comment';
  }

  /**
   * Parses the markdown attribute of the provided element, inserting the corresponding <slot> child
   * if there is no pre-existing slot child with the name of the attribute present.
   * @param node Element to parse
   * @param attribute Attribute name to parse
   * @param isInline Whether to parse the attribute with only inline markdown-it rules
   * @param slotName Name attribute of the <slot> element to insert, which defaults to the attribute name
   */
  static _parseAttributeWithoutOverride(node, attribute, isInline, slotName = attribute) {
    const hasAttributeSlot = node.children
      && node.children.some(child => _.has(child.attribs, 'slot') && child.attribs.slot === slotName);

    if (!hasAttributeSlot && _.has(node.attribs, attribute)) {
      let rendered;
      if (isInline) {
        rendered = md.renderInline(node.attribs[attribute]);
      } else {
        rendered = md.render(node.attribs[attribute]);
      }

      const attributeSlotElement = cheerio.parseHTML(
        `<template slot="${slotName}">${rendered}</template>`, true);
      node.children
        = node.children ? attributeSlotElement.concat(node.children) : attributeSlotElement;
    }

    delete node.attribs[attribute];
  }

  /**
   * Takes an element, looks for direct elements with slots and transforms to avoid Vue parsing.
   * This is so that we can use bootstrap-vue popovers, tooltips, and modals.
   * @param node Element to transform
   */
  static _transformSlottedComponents(node) {
    node.children.forEach((child) => {
      const slot = child.attribs && child.attribs.slot;
      if (slot) {
        // Turns <div slot="content">... into <div data-mb-html-for=content>...
        child.attribs['data-mb-html-for'] = slot;
        delete child.attribs.slot;
      }
      // similarly, need to transform templates to avoid Vue parsing
      if (child.name === 'template') {
        child.name = 'span';
      }
    });
  }

  /*
   * Panels
   */

  static _parsePanelAttributes(node) {
    ComponentParser._parseAttributeWithoutOverride(node, 'alt', false, '_alt');

    const slotChildren = node.children && node.children.filter(child => _.has(child.attribs, 'slot'));
    const hasAltSlot = slotChildren && slotChildren.some(child => child.attribs.slot === '_alt');
    const hasHeaderSlot = slotChildren && slotChildren.some(child => child.attribs.slot === 'header');

    // If both are present, the header attribute has no effect, and we can simply remove it.
    if (hasAltSlot && hasHeaderSlot) {
      delete node.attribs.header;
      return;
    }

    ComponentParser._parseAttributeWithoutOverride(node, 'header', false, '_header');
  }

  /**
   * Traverses the dom breadth-first from the specified element to find a html heading child.
   * @param node Root element to search from
   * @returns {undefined|*} The header element, or undefined if none is found.
   */
  static _findHeaderElement(node) {
    const elements = node.children;
    if (!elements || !elements.length) {
      return undefined;
    }

    const elementQueue = elements.slice(0);
    while (elementQueue.length) {
      const nextEl = elementQueue.shift();
      if ((/^h[1-6]$/).test(nextEl.name)) {
        return nextEl;
      }

      if (nextEl.children) {
        nextEl.children.forEach(child => elementQueue.push(child));
      }
    }

    return undefined;
  }

  /**
   * Assigns an id to the root element of a panel component using the heading specified in the
   * panel's header slot or attribute (if any), with the header slot having priority if present.
   * This is to ensure anchors still work when panels are in their minimized form.
   * @param node The root panel element
   */
  static _assignPanelId(node) {
    const slotChildren = node.children && node.children.filter(child => _.has(child.attribs, 'slot'));
    const headerSlot = slotChildren.find(child => child.attribs.slot === 'header');
    const headerAttributeSlot = slotChildren.find(child => child.attribs.slot === '_header');

    const slotElement = headerSlot || headerAttributeSlot;
    if (slotElement) {
      const header = ComponentParser._findHeaderElement(slotElement);
      if (!header) {
        return;
      }

      if (!header.attribs || !_.has(header.attribs, 'id')) {
        throw new Error('Found a panel heading without an assigned id.\n'
          + 'Please report this to the MarkBind developers. Thank you!');
      }

      node.attribs.id = header.attribs.id;
    }
  }

  /**
   * Check and warns if element has conflicting attributes.
   * Note that attirbutes in `attrsConflictingWith` are not in conflict with each other,
   * but only towards `attribute`
   * @param node Root element to check
   * @param attribute An attribute that is conflicting with other attributes
   * @param attrsConflictingWith The attributes conflicting with `attribute`
   */
  static _warnConflictingAttributes(node, attribute, attrsConflictingWith) {
    if (!(attribute in node.attribs)) {
      return;
    }
    attrsConflictingWith.forEach((conflictingAttr) => {
      if (conflictingAttr in node.attribs) {
        logger.warn(`Usage of conflicting ${node.name} attributes: `
          + `'${attribute}' with '${conflictingAttr}'`);
      }
    });
  }

  /**
   * Check and warns if element has a deprecated attribute.
   * @param node Root element to check
   * @param attributeNamePairs Object of attribute name pairs with each pair in the form deprecated : correct
   */
  static _warnDeprecatedAttributes(node, attributeNamePairs) {
    Object.entries(attributeNamePairs)
      .forEach(([deprecatedAttrib, correctAttrib]) => {
        if (deprecatedAttrib in node.attribs) {
          logger.warn(`${node.name} attribute '${deprecatedAttrib}' `
            + `is deprecated and may be removed in the future. Please use '${correctAttrib}'`);
        }
      });
  }

  /*
   * Questions, QOption, and Quizzes
   */

  static _parseQuestion(node) {
    ComponentParser._parseAttributeWithoutOverride(node, 'header', false, 'header');
    ComponentParser._parseAttributeWithoutOverride(node, 'hint', false, 'hint');
    ComponentParser._parseAttributeWithoutOverride(node, 'answer', false, 'answer');
  }

  static _parseQOption(node) {
    ComponentParser._parseAttributeWithoutOverride(node, 'reason', false, 'reason');
  }

  static _parseQuiz(node) {
    ComponentParser._parseAttributeWithoutOverride(node, 'intro', false, 'intro');
  }

  /*
   * Triggers
   *
   * At "compile time", we can't tell whether a trigger references a modal, popover, or toolip,
   * since that element might not have been processed yet.
   *
   * So, we make every trigger try all 3. It will attempt to open a tooltip, popover, and modal.
   *
   * For tooltips and popovers, we call the relevant content getters inside asset/js/setup.js.
   * They will check to see if the element id exists, and whether it is a popover/tooltip,
   * and then return the content as needed.
   *
   * For modals, we make it attempt to show the modal if it exists.
   */

  static addTriggerClass(node, trigger) {
    const triggerClass = trigger === 'click' ? 'trigger-click' : 'trigger';
    node.attribs.class = node.attribs.class ? `${node.attribs.class} ${triggerClass}` : triggerClass;
  }

  static _parseTrigger(node) {
    node.name = 'span';
    const trigger = node.attribs.trigger || 'hover';
    const placement = node.attribs.placement || 'top';
    node.attribs[`v-b-popover.${trigger}.${placement}.html`]
      = 'popoverGenerator';
    node.attribs[`v-b-tooltip.${trigger}.${placement}.html`]
      = 'tooltipContentGetter';
    const convertedTrigger = trigger === 'hover' ? 'mouseover' : trigger;
    node.attribs[`v-on:${convertedTrigger}`] = `$refs['${node.attribs.for}'].show()`;
    ComponentParser.addTriggerClass(node, convertedTrigger);
  }

  /*
   * Popovers
   *
   * We hide the content and header via _transformSlottedComponents, for retrieval by triggers.
   *
   * Then, we add in a trigger for this popover.
   */

  static _parsePopover(node) {
    ComponentParser._warnDeprecatedAttributes(node, { title: 'header' });

    ComponentParser._parseAttributeWithoutOverride(node, 'content', true);
    ComponentParser._parseAttributeWithoutOverride(node, 'header', true);
    ComponentParser._parseAttributeWithoutOverride(node, 'title', true, 'header');

    node.name = 'span';
    const trigger = node.attribs.trigger || 'hover';
    const placement = node.attribs.placement || 'top';
    node.attribs['data-mb-component-type'] = 'popover';
    node.attribs[`v-b-popover.${trigger}.${placement}.html`]
      = 'popoverInnerGenerator';
    ComponentParser.addTriggerClass(node, trigger);
    ComponentParser._transformSlottedComponents(node);
  }

  /**
   * Check and warns if element has a deprecated slot name
   * @param element Root element to check
   * @param namePairs Object of slot name pairs with each pair in the form deprecated : correct
   */

  static _warnDeprecatedSlotNames(element, namePairs) {
    if (!(element.children)) {
      return;
    }
    element.children.forEach((child) => {
      if (!(_.has(child.attribs, 'slot'))) {
        return;
      }
      Object.entries(namePairs)
        .forEach(([deprecatedName, correctName]) => {
          if (child.attribs.slot !== deprecatedName) {
            return;
          }
          logger.warn(`${element.name} slot name '${deprecatedName}' `
            + `is deprecated and may be removed in the future. Please use '${correctName}'`);
        });
    });
  }

  /*
   * Tooltips
   *
   * Similar to popovers.
   */

  static _parseTooltip(node) {
    ComponentParser._parseAttributeWithoutOverride(node, 'content', true, '_content');

    node.name = 'span';
    const trigger = node.attribs.trigger || 'hover';
    const placement = node.attribs.placement || 'top';
    node.attribs['data-mb-component-type'] = 'tooltip';
    node.attribs[`v-b-tooltip.${trigger}.${placement}.html`]
      = 'tooltipInnerContentGetter';
    ComponentParser.addTriggerClass(node, trigger);
    ComponentParser._transformSlottedComponents(node);
  }

  static _renameSlot(node, originalName, newName) {
    if (node.children) {
      node.children.forEach((c) => {
        const child = c;
        if (_.has(child.attribs, 'slot') && child.attribs.slot === originalName) {
          child.attribs.slot = newName;
        }
      });
    }
  }

  static _renameAttribute(node, originalAttribute, newAttribute) {
    if (_.has(node.attribs, originalAttribute)) {
      node.attribs[newAttribute] = node.attribs[originalAttribute];
      delete node.attribs[originalAttribute];
    }
  }

  /*
   * Modals
   *
   * We are using bootstrap-vue modals, and some of their attributes/slots differ from ours.
   * So, we will transform from markbind modal syntax into bootstrap-vue modal syntax.
   */

  static _parseModalAttributes(node) {
    ComponentParser._warnDeprecatedAttributes(node, { title: 'header' });
    ComponentParser._warnDeprecatedSlotNames(node, {
      'modal-header': 'header',
      'modal-footer': 'footer',
    });

    ComponentParser._parseAttributeWithoutOverride(node, 'header', true, 'modal-title');
    ComponentParser._parseAttributeWithoutOverride(node, 'title', true, 'modal-title');

    ComponentParser._renameSlot(node, 'header', 'modal-header');
    ComponentParser._renameSlot(node, 'footer', 'modal-footer');

    node.name = 'b-modal';

    ComponentParser._renameAttribute(node, 'ok-text', 'ok-title');
    ComponentParser._renameAttribute(node, 'center', 'centered');

    const hasOkTitle = _.has(node.attribs, 'ok-title');
    const hasFooter = node.children.some(child =>
      _.has(child.attribs, 'slot') && child.attribs.slot === 'modal-footer');

    if (!hasFooter && !hasOkTitle) {
      // markbind doesn't show the footer by default
      node.attribs['hide-footer'] = '';
    } else if (hasOkTitle) {
      // bootstrap-vue default is to show ok and cancel
      // if there's an ok-title, markbind only shows the OK button.
      node.attribs['ok-only'] = '';
    }

    if (node.attribs.backdrop === 'false') {
      node.attribs['no-close-on-backdrop'] = '';
    }
    delete node.attribs.backdrop;

    let size = '';
    if (_.has(node.attribs, 'large')) {
      size = 'lg';
      delete node.attribs.large;
    } else if (_.has(node.attribs, 'small')) {
      size = 'sm';
      delete node.attribs.small;
    }
    node.attribs.size = size;

    // default for markbind is zoom, default for bootstrap-vue is fade
    const effect = node.attribs.effect === 'fade' ? '' : 'mb-zoom';
    node.attribs['modal-class'] = effect;

    if (_.has(node.attribs, 'id')) {
      node.attribs.ref = node.attribs.id;
    }
  }

  /*
   * Tabs
   */

  static _parseTabAttributes(node) {
    ComponentParser._parseAttributeWithoutOverride(node, 'header', true, '_header');
  }

  /*
   * Tip boxes
   */

  static _parseBoxAttributes(node) {
    ComponentParser._warnConflictingAttributes(node, 'light', ['seamless']);
    ComponentParser._warnConflictingAttributes(node, 'no-background', ['background-color', 'seamless']);
    ComponentParser._warnConflictingAttributes(node, 'no-border',
                                               ['border-color', 'border-left-color', 'seamless']);
    ComponentParser._warnConflictingAttributes(node, 'no-icon', ['icon']);
    ComponentParser._warnDeprecatedAttributes(node, { heading: 'header' });

    ComponentParser._parseAttributeWithoutOverride(node, 'icon', true, 'icon');
    ComponentParser._parseAttributeWithoutOverride(node, 'header', false, '_header');

    ComponentParser._parseAttributeWithoutOverride(node, 'heading', false, '_header');
  }

  /*
   * Dropdowns
   */

  static _parseDropdownAttributes(node) {
    const slotChildren = node.children && node.children.filter(child => _.has(child.attribs, 'slot'));
    const hasHeaderSlot = slotChildren && slotChildren.some(child => child.attribs.slot === 'header');

    // If header slot is present, the header attribute has no effect, and we can simply remove it.
    if (hasHeaderSlot) {
      if (_.has(node.attribs, 'header')) {
        logger.warn(`${node.name} has a header slot, 'header' attribute has no effect.`);
      }
      if (_.has(node.attribs, 'text')) {
        logger.warn(`${node.name} has a header slot, 'text' attribute has no effect.`);
      }
      delete node.attribs.header;
      delete node.attribs.text;
      return;
    }

    ComponentParser._warnDeprecatedAttributes(node, { text: 'header' });
    ComponentParser._warnConflictingAttributes(node, 'header', ['text']);
    // header attribute takes priority over text attribute if both 'text' and 'header' is used
    if (_.has(node.attribs, 'header')) {
      ComponentParser._parseAttributeWithoutOverride(node, 'header', true, '_header');
      delete node.attribs.text;
    } else {
      ComponentParser._parseAttributeWithoutOverride(node, 'text', true, '_header');
    }
  }

  /**
   * Thumbnails
   */

  static _parseThumbnailAttributes(node) {
    const isImage = _.has(node.attribs, 'src') && node.attribs.src !== '';
    if (isImage) {
      return;
    }

    const text = _.has(node.attribs, 'text') ? node.attribs.text : '';
    if (text === '') {
      return;
    }

    const renderedText = md.renderInline(text);
    node.children = cheerio.parseHTML(renderedText);
    delete node.attribs.text;
  }

  /*
   * API
   */

  static parseComponents(node) {
    try {
      switch (node.name) {
      case 'code':
        node.attribs['v-pre'] = '';
        break;
      case 'panel':
        ComponentParser._parsePanelAttributes(node);
        break;
      case 'question':
        ComponentParser._parseQuestion(node);
        break;
      case 'q-option':
        ComponentParser._parseQOption(node);
        break;
      case 'quiz':
        ComponentParser._parseQuiz(node);
        break;
      case 'trigger':
        ComponentParser._parseTrigger(node);
        break;
      case 'popover':
        ComponentParser._parsePopover(node);
        break;
      case 'tooltip':
        ComponentParser._parseTooltip(node);
        break;
      case 'modal':
        ComponentParser._parseModalAttributes(node);
        break;
      case 'tab':
      case 'tab-group':
        ComponentParser._parseTabAttributes(node);
        break;
      case 'box':
        ComponentParser._parseBoxAttributes(node);
        break;
      case 'dropdown':
        ComponentParser._parseDropdownAttributes(node);
        break;
      case 'thumbnail':
        ComponentParser._parseThumbnailAttributes(node);
        break;
      default:
        break;
      }
    } catch (error) {
      logger.error(error);
    }
  }

  static postParseComponents(node) {
    try {
      switch (node.name) {
      case 'panel':
        ComponentParser._assignPanelId(node);
        break;
      default:
        break;
      }
    } catch (error) {
      logger.error(error);
    }

    if (node.attribs) {
      delete node.attribs[ATTRIB_CWF];
    }
  }

  _parse(node) {
    if (_.isArray(node)) {
      return node.map(el => this._parse(el));
    }
    if (ComponentParser._isText(node)) {
      return node;
    }
    if (node.name) {
      node.name = node.name.toLowerCase();
    }

    const isHeadingTag = (/^h[1-6]$/).test(node.name);

    if (isHeadingTag && !node.attribs.id) {
      const textContent = utils.getTextContent(node);
      // remove the '&lt;' and '&gt;' symbols that markdown-it uses to escape '<' and '>'
      const cleanedContent = textContent.replace(/&lt;|&gt;/g, '');
      const slugifiedHeading = slugify(cleanedContent, { decamelize: false });

      let headerId = slugifiedHeading;
      const { headerIdMap } = this.config;
      if (headerIdMap[slugifiedHeading]) {
        headerId = `${slugifiedHeading}-${headerIdMap[slugifiedHeading]}`;
        headerIdMap[slugifiedHeading] += 1;
      } else {
        headerIdMap[slugifiedHeading] = 2;
      }

      node.attribs.id = headerId;
    }

    switch (node.name) {
    case 'md':
      node.name = 'span';
      node.children = cheerio.parseHTML(md.renderInline(cheerio.html(node.children)), true);
      break;
    case 'markdown':
      node.name = 'div';
      node.children = cheerio.parseHTML(md.render(cheerio.html(node.children)), true);
      break;
    default:
      break;
    }

    ComponentParser.parseComponents(node);

    if (node.children) {
      node.children.forEach((child) => {
        this._parse(child);
      });
    }

    ComponentParser.postParseComponents(node);

    // If a fixed header is applied to the page, generate dummy spans as anchor points
    if (this.config.fixedHeader && isHeadingTag && node.attribs.id) {
      cheerio(node).append(cheerio.parseHTML(`<span id="${node.attribs.id}" class="anchor"></span>`));
    }

    return node;
  }

  render(content, filePath) {
    return new Promise((resolve, reject) => {
      const handler = new htmlparser.DomHandler((error, dom) => {
        if (error) {
          reject(error);
          return;
        }
        const nodes = dom.map((d) => {
          let parsed;
          try {
            parsed = this._parse(d);
          } catch (err) {
            err.message += `\nError while rendering '${filePath}'`;
            logger.error(err);
            parsed = utils.createErrorNode(d, err);
          }
          return parsed;
        });
        nodes.forEach(d => ComponentParser._trimNodes(d));

        resolve(cheerio.html(nodes));
      });
      const parser = new htmlparser.Parser(handler);
      const fileExt = utils.getExt(filePath);
      if (utils.isMarkdownFileExt(fileExt)) {
        const renderedContent = md.render(content);
        parser.parseComplete(renderedContent);
      } else if (fileExt === 'html') {
        parser.parseComplete(content);
      } else {
        const error = new Error(`Unsupported File Extension: '${fileExt}'`);
        reject(error);
      }
    });
  }
}

module.exports = {
  ComponentParser,
};

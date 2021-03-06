/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 */

'use strict';

const RelayModernRecord = require('./RelayModernRecord');

const invariant = require('invariant');

const {
  CONDITION,
  FRAGMENT_SPREAD,
  INLINE_FRAGMENT,
  LINKED_FIELD,
  MODULE_IMPORT,
  SCALAR_FIELD,
} = require('../util/RelayConcreteNode');
const {
  FRAGMENTS_KEY,
  FRAGMENT_OWNER_KEY,
  FRAGMENT_PROP_NAME_KEY,
  ID_KEY,
  MODULE_COMPONENT_KEY,
  getArgumentValues,
  getStorageKey,
} = require('./RelayStoreUtils');

import type {
  ReaderFragmentSpread,
  ReaderLinkedField,
  ReaderModuleImport,
  ReaderNode,
  ReaderScalarField,
  ReaderSelectableNode,
  ReaderSelection,
} from '../util/ReaderNode';
import type {Record, SelectorData} from '../util/RelayCombinedEnvironmentTypes';
import type {DataID, Variables} from '../util/RelayRuntimeTypes';
import type {
  OperationDescriptor,
  RecordSource,
  ReaderSelector,
  Snapshot,
} from './RelayStoreTypes';

function read(
  recordSource: RecordSource,
  selector: ReaderSelector,
  owner?: ?OperationDescriptor,
): Snapshot {
  const {dataID, node, variables} = selector;
  const reader = new RelayReader(recordSource, variables, owner ?? null);
  return reader.read(node, dataID);
}

/**
 * @private
 */
class RelayReader {
  _recordSource: RecordSource;
  _seenRecords: {[dataID: DataID]: ?Record};
  _variables: Variables;
  _isMissingData: boolean;
  _owner: OperationDescriptor | null;

  constructor(
    recordSource: RecordSource,
    variables: Variables,
    owner: OperationDescriptor | null,
  ) {
    this._recordSource = recordSource;
    this._seenRecords = {};
    this._isMissingData = false;
    this._variables = variables;
    this._owner = owner;
  }

  read(node: ReaderSelectableNode, dataID: DataID): Snapshot {
    const data = this._traverse(node, dataID, null);
    return {
      data,
      dataID,
      node,
      seenRecords: this._seenRecords,
      variables: this._variables,
      isMissingData: this._isMissingData,
      owner: this._owner,
    };
  }

  _traverse(
    node: ReaderNode,
    dataID: DataID,
    prevData: ?SelectorData,
  ): ?SelectorData {
    const record = this._recordSource.get(dataID);
    this._seenRecords[dataID] = record;
    if (record == null) {
      if (record === undefined) {
        this._isMissingData = true;
      }
      return record;
    }
    const data = prevData || {};
    this._traverseSelections(node.selections, record, data);
    return data;
  }

  _getVariableValue(name: string): mixed {
    invariant(
      this._variables.hasOwnProperty(name),
      'RelayReader(): Undefined variable `%s`.',
      name,
    );
    return this._variables[name];
  }

  _traverseSelections(
    selections: $ReadOnlyArray<ReaderSelection>,
    record: Record,
    data: SelectorData,
  ): void {
    selections.forEach(selection => {
      if (selection.kind === SCALAR_FIELD) {
        this._readScalar(selection, record, data);
      } else if (selection.kind === LINKED_FIELD) {
        if (selection.plural) {
          this._readPluralLink(selection, record, data);
        } else {
          this._readLink(selection, record, data);
        }
      } else if (selection.kind === CONDITION) {
        const conditionValue = this._getVariableValue(selection.condition);
        if (conditionValue === selection.passingValue) {
          this._traverseSelections(selection.selections, record, data);
        }
      } else if (selection.kind === INLINE_FRAGMENT) {
        const typeName = RelayModernRecord.getType(record);
        if (typeName != null && typeName === selection.type) {
          this._traverseSelections(selection.selections, record, data);
        }
      } else if (selection.kind === FRAGMENT_SPREAD) {
        this._createFragmentPointer(selection, record, data, this._variables);
      } else if (selection.kind === MODULE_IMPORT) {
        this._readModuleImport(selection, record, data);
      } else {
        invariant(
          false,
          'RelayReader(): Unexpected ast kind `%s`.',
          selection.kind,
        );
      }
    });
  }

  _readScalar(
    field: ReaderScalarField,
    record: Record,
    data: SelectorData,
  ): void {
    const applicationName = field.alias ?? field.name;
    const storageKey = getStorageKey(field, this._variables);
    const value = RelayModernRecord.getValue(record, storageKey);
    if (value === undefined) {
      this._isMissingData = true;
    }
    data[applicationName] = value;
  }

  _readLink(
    field: ReaderLinkedField,
    record: Record,
    data: SelectorData,
  ): void {
    const applicationName = field.alias ?? field.name;
    const storageKey = getStorageKey(field, this._variables);
    const linkedID = RelayModernRecord.getLinkedRecordID(record, storageKey);
    if (linkedID == null) {
      data[applicationName] = linkedID;
      if (linkedID === undefined) {
        this._isMissingData = true;
      }
      return;
    }

    const prevData = data[applicationName];
    invariant(
      prevData == null || typeof prevData === 'object',
      'RelayReader(): Expected data for field `%s` on record `%s` ' +
        'to be an object, got `%s`.',
      applicationName,
      RelayModernRecord.getDataID(record),
      prevData,
    );
    data[applicationName] = this._traverse(field, linkedID, prevData);
  }

  _readPluralLink(
    field: ReaderLinkedField,
    record: Record,
    data: SelectorData,
  ): void {
    const applicationName = field.alias ?? field.name;
    const storageKey = getStorageKey(field, this._variables);
    const linkedIDs = RelayModernRecord.getLinkedRecordIDs(record, storageKey);

    if (linkedIDs == null) {
      data[applicationName] = linkedIDs;
      if (linkedIDs === undefined) {
        this._isMissingData = true;
      }
      return;
    }

    const prevData = data[applicationName];
    invariant(
      prevData == null || Array.isArray(prevData),
      'RelayReader(): Expected data for field `%s` on record `%s` ' +
        'to be an array, got `%s`.',
      applicationName,
      RelayModernRecord.getDataID(record),
      prevData,
    );
    const linkedArray = prevData || [];
    linkedIDs.forEach((linkedID, nextIndex) => {
      if (linkedID == null) {
        if (linkedID === undefined) {
          this._isMissingData = true;
        }
        linkedArray[nextIndex] = linkedID;
        return;
      }
      const prevItem = linkedArray[nextIndex];
      invariant(
        prevItem == null || typeof prevItem === 'object',
        'RelayReader(): Expected data for field `%s` on record `%s` ' +
          'to be an object, got `%s`.',
        applicationName,
        RelayModernRecord.getDataID(record),
        prevItem,
      );
      linkedArray[nextIndex] = this._traverse(field, linkedID, prevItem);
    });
    data[applicationName] = linkedArray;
  }

  /**
   * Reads a ReaderModuleImport, which was generated from using the @module
   * directive.
   */
  _readModuleImport(
    moduleImport: ReaderModuleImport,
    record: Record,
    data: SelectorData,
  ): void {
    // Determine the component module from the store: if the field is missing
    // it means we don't know what component to render the match with.
    const component = RelayModernRecord.getValue(record, MODULE_COMPONENT_KEY);
    if (component == null) {
      if (component === undefined) {
        this._isMissingData = true;
      }
      return;
    }

    // Otherwise, read the fragment and module associated to the concrete
    // type, and put that data with the result:
    // - For the matched fragment, create the relevant fragment pointer and add
    //   the expected fragmentPropName
    // - For the matched module, create a reference to the module
    this._createFragmentPointer(
      {
        kind: 'FragmentSpread',
        name: moduleImport.fragmentName,
        args: null,
      },
      record,
      data,
      this._variables,
    );
    data[FRAGMENT_PROP_NAME_KEY] = moduleImport.fragmentPropName;
    data[MODULE_COMPONENT_KEY] = component;
  }

  _createFragmentPointer(
    fragmentSpread: ReaderFragmentSpread,
    record: Record,
    data: SelectorData,
    variables: Variables,
  ): void {
    let fragmentPointers = data[FRAGMENTS_KEY];
    if (fragmentPointers == null) {
      fragmentPointers = data[FRAGMENTS_KEY] = {};
    }
    invariant(
      typeof fragmentPointers === 'object' && fragmentPointers,
      'RelayReader: Expected fragment spread data to be an object, got `%s`.',
      fragmentPointers,
    );
    if (data[ID_KEY] == null) {
      data[ID_KEY] = RelayModernRecord.getDataID(record);
    }
    fragmentPointers[fragmentSpread.name] = fragmentSpread.args
      ? getArgumentValues(fragmentSpread.args, variables)
      : {};
    data[FRAGMENT_OWNER_KEY] = this._owner;
  }
}

module.exports = {read};

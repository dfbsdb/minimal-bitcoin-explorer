/* eslint-disable capitalized-comments */
/* eslint-disable camelcase */
/* eslint-disable no-await-in-loop */

'use strict';
const assert = require('assert');

const explore = {
	bc: null,
	db: null
};

const db = {
	beginTransaction: () => {
		explore.db.prepare('begin transaction')
			.run();
	},
	commit: () => {
		explore.db.prepare('commit')
			.run();
	},
	selectCountBlock: () => {
		const ret = explore.db.prepare('select count (*) as ts_counter from block')
			.get();
		assert(typeof ret !== 'undefined');
		return ret;
	},
	selectLastBlock: () => {
		const ret = explore.db.prepare('select height, hash, nextblockhash from block where height = (select max (height) from block)')
			.get();
		assert(typeof ret !== 'undefined');
		return ret;
	},
	insertBlock: block => {
		const info = explore.db.prepare('insert into block(height, hash, nextblockhash) values (?, ?, ?)')
			.run(block.height, block.hash, block.nextblockhash);
		assert(info.changes === 1);
		return info;
	},
	insertTransaction: (txid, block_ref) => {
		const info = explore.db.prepare('insert into h_transaction(txid, block_ref) values (?, ?)')
			.run(txid, block_ref);
		assert(info.changes === 1);
		return info;
	},
	insertUtxo: (transaction_ref, vout, value) => {
		const info = explore.db.prepare('insert into utxo(transaction_ref, vout, value) values (?, ?, ?)')
			.run(transaction_ref, vout, value);
		assert(info.changes === 1);
		return info;
	},
	upsertSpkType: type => {
		const info = explore.db.prepare('insert into spk_type (description, counter) values (?, 1) ' +
			'ON CONFLICT(description) DO UPDATE SET counter = (select counter + 1 from spk_type where description = ?)')
			.run(type, type);
		assert(info.changes === 1);
		return info;
	},
	upsertAddress: (text, hex_ref) => {
		const info = explore.db.prepare('insert into address(address, hex_ref, counter) values (?, (' + hex_ref + '),1) ' +
			'ON CONFLICT(address) DO UPDATE SET counter = (select counter + 1 from address where address = ?)')
			.run(text, text);
		assert(info.changes === 1);
		return info;
	},
	upsertHex: (hex, spk_type_ref, satoshi) => {
		assert(typeof hex !== 'undefined');
		assertSatoshi(satoshi);
		const info = explore.db.prepare('insert into hex(hex, spk_type_ref, counter, satoshi) values (?, (' + spk_type_ref + '),1, ?) ' +
			'ON CONFLICT(hex) DO UPDATE SET counter = (select counter + 1 from hex where hex = ?), satoshi = ? + (select satoshi where hex = ?)')
			.run(hex, satoshi, hex, satoshi, hex);
		assert(info.changes === 1);
		return info;
	},
	insertUtxoHex: (utxo_ref, ref) => {
		const info = explore.db.prepare('insert into utxo_hex(utxo_ref, hex_ref) values (?, (' + ref + '))')
			.run(utxo_ref);
		assert(info.changes === 1);
		return info;
	},
	updateHexDelta: (hex, deltaSatoshi) => {
		assert(typeof hex !== 'undefined');
		const info = explore.db.prepare('update hex set satoshi = (select satoshi + ? from hex where hex = ?) where hex = ?')
			.run(deltaSatoshi, hex, hex);
		assert(info.changes === 1);
		return info;
	},
	updateHex: (hex, satoshi) => {
		assert(typeof hex !== 'undefined');
		assertSatoshi(satoshi);
		const info = explore.db.prepare('update hex set satoshi = ? where hex = ?')
			.run(satoshi, hex);
		assert(info.changes === 1);
		return info;
	},
	selectVout: (txid, vout) => {
		const ret = explore.db.prepare('select id, hex, value, satoshi from vv_utxo_hex ' +
			'where transaction_ref = (select id from h_transaction where txid = ?) and vout = ? and spent=0')
			.get(txid, vout);
		assert(typeof ret !== 'undefined');
		assertSatoshi(ret.satoshi);
		return ret;
	},
	updateUtxoSpent: id => {
		const info = explore.db.prepare('update utxo set spent = 1 where id = ?')
			.run(id);
		assert(info.changes === 1);
		return info;
	}
};

const assertSatoshi = satoshi => {
	assert(typeof satoshi !== 'undefined');
	assert(Number.isInteger(satoshi));
};

const valueToSatoshi = bitcoin => {
	assert(typeof bitcoin !== 'undefined');
	// 32.91*100000000 = 3290999999.9999995!!!
	const satoshi = Math.round(bitcoin * 100000000);
	assertSatoshi(satoshi);
	return satoshi;
};

const handleTransaction = (raw, block_ref) => {
	assert(typeof raw !== 'undefined');
	assert(typeof block_ref !== 'undefined');
	const transaction = db.insertTransaction(raw.txid, block_ref);
	// console.log (raw);
	raw.vout.forEach(vout => {
		assert(typeof vout !== 'undefined');
		db.upsertSpkType(vout.scriptPubKey.type);
		const transaction_ref = transaction.lastInsertRowid;
		const utxo = db.insertUtxo(transaction_ref, vout.n, vout.value);
		const utxo_ref = utxo.lastInsertRowid;
		const spk_type_ref = 'select id from spk_type where description=\'' + vout.scriptPubKey.type + '\'';
		db.upsertHex(vout.scriptPubKey.hex, spk_type_ref, valueToSatoshi(vout.value));
		const hex_ref = 'select id from hex where hex=\'' + vout.scriptPubKey.hex + '\'';
		db.insertUtxoHex(utxo_ref, hex_ref);
		if (vout.scriptPubKey.addresses) {
			vout.scriptPubKey.addresses.forEach(address => {
				db.upsertAddress(address, hex_ref);
			});
		}
	});

	raw.vin.forEach(vin => {
		if (!vin.coinbase) {
			const voutFound = db.selectVout(vin.txid, vin.vout);
			assert(typeof voutFound !== 'undefined');
			const satoshi = voutFound.satoshi - valueToSatoshi(voutFound.value);
			assert(satoshi >= 0);
			db.updateHex(voutFound.hex, satoshi);
			db.updateUtxoSpent(voutFound.id);
		}
	});
};

const profile = {
	delta: {
		rpc: 0,
		db: {
			query: 0,
			commit: 0
		}
	}
};

const main = async () => {
	const BitcoinCore = require('bitcoin-core');
	const configuration = require('./configuration');
	const BetterSqlite3 = require('better-sqlite3');
	explore.db = new BetterSqlite3('explore.sqlite', {
		verboseNo: query => {
			assert(typeof query !== 'undefined');
			console.log(JSON.stringify({query}));
		}
	});

	explore.bc = new BitcoinCore(configuration.bitcoinCore);
	let lastBlock = {};
	if (db.selectCountBlock().ts_counter > 0) {
		lastBlock = db.selectLastBlock();
	} else {
		// genesis block.hash
		lastBlock.nextblockhash = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
	}
	let dbEnd = new Date();
	for (;;) {
		db.beginTransaction();
		let lastDate = new Date();
		for (let i = 0; i < 10; ++i) {
			lastBlock = await explore.bc.getBlock(lastBlock.nextblockhash, 2);
			const rpcEnd = new Date();
			profile.delta.rpc += rpcEnd - dbEnd;
			assert(typeof lastBlock !== 'undefined');

			if ((lastBlock.height % 100) === 0) {
				const date = new Date();
				const delta = date - lastDate;
				console.log({height: lastBlock.height, date, delta});
				lastDate = date;
			}

			const insertBlockResult = db.insertBlock(lastBlock);

			lastBlock.tx.forEach(raw => {
				handleTransaction(raw, insertBlockResult.lastInsertRowid);
			});
			dbEnd = new Date();
			profile.delta.db.query += dbEnd - rpcEnd;
		}
		db.commit();
		const dbCommitEnd = new Date();
		profile.delta.db.commit += dbCommitEnd - dbEnd;
		dbEnd = dbCommitEnd;
		console.log(JSON.stringify({profile}));
	}
};

main();



// symbol-sdk と関連モジュールのインポート
const sym = require("symbol-sdk");

const MAINNODE = "https://xym748.allnodes.me:3001";           // MAINNET
const TESTNODE = "https://vmi831828.contaboserver.net:3001";  // TESTNET

// ネットワークタイプ
const NetTypeEnum = {
  Main : 104,
  Test : 152,
};

// リポジトリ
let repo = null;
let txRepo = null;
let accountRepo = null;
let msRepo = null;
let nsRepo = null;
let wsEndpoint = null;
// トランザクション作成で使用するデータ
let networkType = null;
let generationHash = null;
let epochAdjustment = null;

// 初期設定
initSetting = (async function(netType) {
  // ノードURIの取得
  let nodeUri = '';
  switch (Number(netType)) {
    // メインネット
    case NetTypeEnum.Main:
      nodeUri = MAINNODE;
      break;
  
    // テストネット
    case NetTypeEnum.Test:
      nodeUri = TESTNODE;
      break;
  
    default:
      return false;
  }

  // リポジトリ設定
  repo = new sym.RepositoryFactoryHttp(nodeUri);
  accountRepo = repo.createAccountRepository();
  msRepo = repo.createMultisigRepository();
  txRepo = repo.createTransactionRepository();
  nsRepo = repo.createNamespaceRepository();
  wsEndpoint = nodeUri.replace('http', 'ws') + "/ws";

  // トランザクション作成で使用するデータの設定
  networkType = await repo.getNetworkType().toPromise();
  generationHash = await repo.getGenerationHash().toPromise();
  epochAdjustment = await repo.getEpochAdjustment().toPromise();

  return true;
});

// マルチシグアドレスの取得
getMultisigAddresses = (async function(address) {
  // リポジトリ設定ができているか確認
  if (null === networkType) {
    return null;
  }
  const rawAddress = sym.Address.createFromRawAddress(address);
  const accountInfo = await accountRepo.getAccountInfo(rawAddress).toPromise();
  const multisigInfo = await msRepo.getMultisigAccountInfo(accountInfo.address).toPromise();
  if (multisigInfo.isMultisig()) {
    return null;
  }
  return multisigInfo.multisigAddresses;
});

// マルチシグ用モザイク作成
createMosaicForMultisig = (async function(address, multisigAddress, supplyAmount, supplyMutable, transferable, restrictable, revokable) {
  // リポジトリ設定ができているか確認
  if (null === networkType) {
    return null;
  }

  // アカウントオブジェクトの作成
  const rawAddress = sym.Address.createFromRawAddress(address);
  const accountInfo = await accountRepo.getAccountInfo(rawAddress).toPromise();
  const rawMultisigAddress = sym.Address.createFromRawAddress(multisigAddress);
  const multisigAccountInfo = await accountRepo.getAccountInfo(rawMultisigAddress).toPromise();

  // マルチシグアカウントかチェック
  const multisigInfo = await msRepo.getMultisigAccountInfo(multisigAccountInfo.address).toPromise();
  if (!(multisigInfo.isMultisig())) {
    return null;
  }

  // モザイク作成Txを作成し、SSSで署名
  const mosaicTx = createMosaicTx(multisigAccountInfo, supplyAmount, supplyMutable, transferable, restrictable, revokable);
  window.SSS.setTransaction(mosaicTx);
  const signedCreateMosaicTx = await window.SSS.requestSign();

  // マルチシグ向けTxのアナウンス
  return await multisigTxAnnounce(signedCreateMosaicTx, accountInfo.address);
});

// マルチシグ連署者署名
createMosaicForMultisig = (async function(address, multisigAddress) {
  // リポジトリ設定ができているか確認
  if (null === networkType) {
    return null;
  }

  // アカウントオブジェクトの作成
  const rawAddress = sym.Address.createFromRawAddress(address);
  const accountInfo = await accountRepo.getAccountInfo(rawAddress).toPromise();
  const rawMultisigAddress = sym.Address.createFromRawAddress(multisigAddress);
  const multisigAccountInfo = await accountRepo.getAccountInfo(rawMultisigAddress).toPromise();

  // マルチシグアカウントかチェック
  const multisigInfo = await msRepo.getMultisigAccountInfo(multisigAccountInfo.address).toPromise();
  if (!(multisigInfo.isMultisig())) {
    return null;
  }

  // トランザクションリスナーオープン
  const txListener = new sym.Listener(wsEndpoint, nsRepo, WebSocket);
  await txListener.open();
  {
    // 切断軽減のためのブロック生成検知
    txListener.newBlock();

    // ハッシュロックトランザクションの承認検知
    txListener.aggregateBondedAdded(accountInfo.address)
    .subscribe(async aggregateTx => {
      if (!(sym.TransactionType.MOSAIC_DEFINITION === aggregateTx.innerTransactions[0].type)
          && !(sym.TransactionType.TRANSFER === aggregateTx.innerTransactions[0].type)) {
        return;
      }

      // トランザクションに連署してアナウンス
      window.SSS.setTransaction(aggregateTx);
      const signedAggregateTx = await window.SSS.requestSignCosignatureTransaction();
      await new sym.TransactionHttp(networkType)
                    .announceAggregateBondedCosignature(signedAggregateTx).toPromise();
      // リスナーをクローズ
      txListener.close();
    });
  }
  return true;
});

// 連署されたTxのアナウンス
announceCoSignedTx = (async function(netType, signedTx) {
  // リポジトリ設定ができているか確認
  if (null === networkType) {
    return false;
  }
  await new sym.TransactionHttp(networkType)
                .announceAggregateBondedCosignature(signedTx).toPromise();
});

// モザイク作成Txの作成
function createMosaicTx(createAccountInfo, supplyAmount, supplyMutable, transferable, restrictable, revokable) {
  // モザイク定義
  const nonce = sym.MosaicNonce.createRandom();
  const mosaicDefTx = sym.MosaicDefinitionTransaction.create(
      undefined, 
      nonce,
      sym.MosaicId.createFromNonce(nonce, createAccountInfo.address), // モザイクID
      sym.MosaicFlags.create(supplyMutable, transferable, restrictable, revokable),
      0,                        // divisibility:可分性
      sym.UInt64.fromUint(0),   // duration:有効期限
      networkType
  );
  
  // モザイク数量設定
  const mosaicChangeTx = sym.MosaicSupplyChangeTransaction.create(
      undefined,
      mosaicDefTx.mosaicId,
      sym.MosaicSupplyChangeAction.Increase,
      sym.UInt64.fromUint(supplyAmount),
      networkType
  );

  // アグリゲートトランザクションを作成して返却
  // NOTE: マルチシグアカウントで作成するためアグリゲートボンデッド
  return sym.AggregateTransaction.createBonded(
    sym.Deadline.create(epochAdjustment),
    [
      mosaicDefTx.toAggregate(createAccountInfo.publicAccount),
      mosaicChangeTx.toAggregate(createAccountInfo.publicAccount),
    ],
    networkType,[],
  ).setMaxFeeForAggregate(300, 0);
}

// ハッシュロックTxの作成
function createHashLockTx(signedTx) {
  // ハッシュロックトランザクション作成
  return sym.HashLockTransaction.create(
    sym.Deadline.create(epochAdjustment),
    new sym.Mosaic(new sym.NamespaceId("symbol.xym"), sym.UInt64.fromUint(10 * 1000000)),  // 固定値:10XYM
    sym.UInt64.fromUint(480),
    signedTx,
    networkType
  ).setMaxFee(300);
}

// マルチシグ向けTxのアナウンス
async function multisigTxAnnounce(signedTx, signerAddress) {
  await new Promise(resolve => setTimeout(resolve, 5000));

  // ハッシュロックTxを作成し、SSSで署名
  const hashLockTx = createHashLockTx(signedTx);
  window.SSS.setTransaction(hashLockTx);
  const signedHashLockTx = await window.SSS.requestSign();

  // トランザクションリスナーオープン
  const txListener = new sym.Listener(wsEndpoint, nsRepo, WebSocket);
  await txListener.open();
  {
    // 切断軽減のためのブロック生成検知
    txListener.newBlock();

    // ハッシュロックトランザクションの承認検知
    txListener.confirmed(signerAddress, signedHashLockTx.hash)
    .subscribe(() => {
      // アグリゲートボンデッドトランザクションをアナウンス
      txRepo.announceAggregateBonded(signedTx).toPromise();
      // リスナーをクローズ
      txListener.close();
    });
  }
  
  // ハッシュロックトランザクションをアナウンス
  await txRepo.announce(signedHashLockTx).toPromise();

  // トランザクションリスナーがクローズされるまで待機
  while (txListener.isOpen()) {
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
}
import { ethers } from 'hardhat'
import { parseEther } from '@ethersproject/units'
import chai from 'chai'
import { solidity } from 'ethereum-waffle'
import { createAndInitializeToken, fundUserAndApprovePool, setupYYAvaxPriceFeed } from '../helpers/helper'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { ContractFactory } from '@ethersproject/contracts'
import { setupAggregateAccount } from '../helpers/helper'
import { BigNumber } from '@ethersproject/bignumber'

const { expect } = chai
chai.use(solidity)

describe('AvaxPool Withdraw Other Asset', function () {
  let owner: SignerWithAddress
  let users: SignerWithAddress[]
  let TestWAVAX: ContractFactory
  let Pool: ContractFactory
  let Asset: ContractFactory
  let WETHForwarder: ContractFactory

  beforeEach(async function () {
    const [first, ...rest] = await ethers.getSigners()
    owner = first
    users = rest

    // Get contracts for Pool, Asset
    TestWAVAX = await ethers.getContractFactory('TestWAVAX')
    Pool = await ethers.getContractFactory('PoolYYAvax')
    Asset = await ethers.getContractFactory('Asset')
    WETHForwarder = await ethers.getContractFactory('WETHForwarder')
  })

  beforeEach(async function () {
    this.lastBlock = await ethers.provider.getBlock('latest')
    this.lastBlockTime = this.lastBlock.timestamp
    this.fiveSecondsSince = this.lastBlockTime + 5 * 1000
    this.fiveSecondsAgo = this.lastBlockTime - 5 * 1000

    this.WETH = await TestWAVAX.connect(owner).deploy()
    await this.WETH.deployTransaction.wait()

    this.pool = await Pool.connect(owner).deploy()

    await this.pool.deployTransaction.wait()
    await this.pool.connect(owner).initialize(this.WETH.address)

    this.forwarder = await WETHForwarder.connect(owner).deploy(this.WETH.address)
    await this.forwarder.deployTransaction.wait()

    await this.forwarder.connect(owner).setPool(this.pool.address)
    await this.pool.connect(owner).setWETHForwarder(this.forwarder.address)

    this.yyOracle = await setupYYAvaxPriceFeed(this.pool)
    await this.yyOracle.setRate(BigNumber.from('1012287344219239968'))
  })

  describe('ETH asset WAVAX and yyAVAX', function () {
    beforeEach(async function () {
      const aggregateName = 'Liquid staking AVAX Aggregate'
      const aggregateAccount = await setupAggregateAccount(owner, aggregateName, true)
      await aggregateAccount.deployTransaction.wait()

      // get some WETH for owner
      await this.WETH.deposit({ value: parseEther('25') })

      this.assetAVAX = await Asset.connect(owner).deploy()
      await this.assetAVAX
        .connect(owner)
        .initialize(this.WETH.address, 'AVAX Asset', 'LP-AVAX', aggregateAccount.address)
      await this.assetAVAX.connect(owner).setPool(this.pool.address)
      await this.pool.connect(owner).addAsset(this.WETH.address, this.assetAVAX.address)

      const tokenSetSAvax = await createAndInitializeToken('yyAVAX', 18, owner, this.pool, aggregateAccount)

      this.yyAVAX = tokenSetSAvax.token
      this.assetSAVAX = tokenSetSAvax.asset

      await this.pool.setYYAvax(this.yyAVAX.address)

      await fundUserAndApprovePool(this.yyAVAX, users[0], parseEther('100000').toString(), this.pool, owner)

      // 1000 AVAX and 1000 yyAVAX
      await this.pool
        .connect(users[0])
        .depositETH(users[0].address, this.fiveSecondsSince, { value: parseEther('100') })
      await this.pool
        .connect(users[0])
        .deposit(this.yyAVAX.address, parseEther('100'), users[0].address, this.fiveSecondsSince)
    })

    // AVAX to yyAVAX
    // should need to send more AVAX than you receive yyAVAX
    it('works to withdraw from other asset of same aggregate AVAX to yyAVAX', async function () {
      // Here we are using our AVAX LP to withdraw yyAVAX!
      // add 70 cash to yyAVAX
      await this.assetSAVAX.connect(owner).setPool(owner.address)
      await this.assetSAVAX.connect(owner).addCash(parseEther('70'))
      await this.yyAVAX.connect(owner).transfer(this.assetSAVAX.address, parseEther('70'))
      await this.assetSAVAX.connect(owner).setPool(this.pool.address)

      const maxWithdrawableAmount = await this.pool.quoteMaxInitialAssetWithdrawable(
        this.WETH.address,
        this.yyAVAX.address
      )
      expect(maxWithdrawableAmount).to.be.equal(parseEther('70.860114095346797760'))

      const beforeBalance = await this.yyAVAX.balanceOf(users[0].address)

      // quote withdrawal using USDC Asset to withdraw DAI
      const [quotedWithdrawal] = await this.pool.quotePotentialWithdrawFromOtherAsset(
        this.WETH.address,
        this.yyAVAX.address,
        parseEther('70')
      )

      await this.assetAVAX.connect(users[0]).approve(this.pool.address, ethers.constants.MaxUint256)

      // check before call
      const receipt = await this.pool
        .connect(users[0])
        .withdrawFromOtherAsset(
          this.WETH.address,
          this.yyAVAX.address,
          parseEther('70'),
          parseEther('0'),
          users[0].address,
          this.fiveSecondsSince
        )

      const afterBalance = await this.yyAVAX.balanceOf(users[0].address)

      // check that quoted withdrawal is the same as amount withdrawn
      expect(afterBalance.sub(beforeBalance)).to.be.equal(quotedWithdrawal)

      expect(afterBalance.sub(beforeBalance)).to.be.equal(parseEther('70'))
      expect(await this.assetAVAX.balanceOf(users[0].address)).to.be.equal(parseEther('29.139885904653202240'))
      expect(await this.assetAVAX.cash()).to.be.equal(parseEther('100'))
      expect(await this.assetAVAX.liability()).to.be.equal(parseEther('29.139885904653202240'))
      expect(await this.assetAVAX.underlyingTokenBalance()).to.be.equal(parseEther('100'))
      expect(await this.assetAVAX.totalSupply()).to.be.equal(parseEther('29.139885904653202240'))

      expect(await this.assetSAVAX.cash()).to.be.equal(parseEther('100'))
      expect(await this.assetSAVAX.liability()).to.be.equal(parseEther('100'))
      expect(await this.assetSAVAX.underlyingTokenBalance()).to.be.equal(parseEther('100'))
      expect(await this.assetSAVAX.totalSupply()).to.be.equal(parseEther('100'))

      expect(receipt)
        .to.emit(this.pool, 'Withdraw')
        .withArgs(
          users[0].address,
          this.yyAVAX.address,
          parseEther('70'),
          parseEther('70.860114095346797760'),
          users[0].address
        )
    })

    /// use yyAVAX to withdraw AVAX. We should send less than expected with current rates
    it('works to withdraw from other asset of same aggregate yyAVAX to AVAX', async function () {
      // Here we are using our yyAVAX LP to withdraw AVAX!
      // add 25 cash to AVAX
      await this.assetAVAX.connect(owner).setPool(owner.address)
      await this.assetAVAX.connect(owner).addCash(parseEther('25'))
      await this.WETH.connect(owner).transfer(this.assetAVAX.address, parseEther('25'))
      await this.assetAVAX.connect(owner).setPool(this.pool.address)

      const maxWithdrawableAmount = await this.pool.quoteMaxInitialAssetWithdrawable(
        this.yyAVAX.address,
        this.WETH.address
      )
      expect(maxWithdrawableAmount).to.be.equal(parseEther('24.696545049945354502'))

      const beforeBalance = await ethers.provider.getBalance(users[1].address)

      // quote withdrawal using USDC Asset to withdraw DAI
      const [quotedWithdrawal] = await this.pool.quotePotentialWithdrawFromOtherAsset(
        this.yyAVAX.address,
        this.WETH.address,
        parseEther('25')
      )

      await this.assetSAVAX.connect(users[0]).approve(this.pool.address, ethers.constants.MaxUint256)

      // withdraw to users[1] so can test the exact ETH received (users[0] needs to pay gas)
      const receipt = await this.pool
        .connect(users[0])
        .withdrawFromOtherAsset(
          this.yyAVAX.address,
          this.WETH.address,
          parseEther('25'),
          parseEther('0'),
          users[1].address,
          this.fiveSecondsSince
        )

      const afterBalance = await ethers.provider.getBalance(users[1].address)

      // check that quoted withdrawal is the same as amount withdrawn
      expect(afterBalance.sub(beforeBalance)).to.be.equal(quotedWithdrawal)

      expect(afterBalance.sub(beforeBalance)).to.be.equal(parseEther('25'))
      expect(await this.assetSAVAX.balanceOf(users[0].address)).to.be.equal(parseEther('75.303454950054645498'))
      expect(await this.assetSAVAX.cash()).to.be.equal(parseEther('100'))
      expect(await this.assetSAVAX.liability()).to.be.equal(parseEther('75.303454950054645498'))
      expect(await this.assetSAVAX.underlyingTokenBalance()).to.be.equal(parseEther('100'))
      expect(await this.assetSAVAX.totalSupply()).to.be.equal(parseEther('75.303454950054645498'))

      expect(await this.assetAVAX.cash()).to.be.equal(parseEther('100'))
      expect(await this.assetAVAX.liability()).to.be.equal(parseEther('100'))
      expect(await this.assetAVAX.underlyingTokenBalance()).to.be.equal(parseEther('100'))
      expect(await this.assetAVAX.totalSupply()).to.be.equal(parseEther('100'))

      expect(receipt)
        .to.emit(this.pool, 'Withdraw')
        .withArgs(
          users[0].address,
          this.WETH.address,
          parseEther('25'),
          parseEther('24.696545049945354502'),
          users[1].address
        )
    })
  })
})

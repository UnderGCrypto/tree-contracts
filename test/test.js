const { getNamedAccounts, deployments, ethers } = require('@nomiclabs/buidler')
const { expect } = require('chai')
const BigNumber = require('bignumber.js')

const { get } = deployments

const config = require('../deploy-configs/mainnet.json')
const forests = require('../deploy-configs/forests.json')
const HOUR = 60 * 60
const DAY = 24 * HOUR
const PRECISION = BigNumber(1e18).toFixed()
const REG_POOL_TREES = 1e21 // 1000 TREE per regular pool
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
const UNI_ROUTER_ADDR = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
const SNX_ADDR = '0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f'
const USDT_ADDR = '0xdAC17F958D2ee523a2206206994597C13D831ec7'

// travel `time` seconds forward in time
const timeTravel = (time) => {
  return ethers.provider.send('evm_increaseTime', [time])
}

const toBigNumber = (bn) => {
  return BigNumber(bn.toString())
}

const setupTest = deployments.createFixture(async ({ deployments, getNamedAccounts, ethers }, options) => {
  const { get } = deployments
  const { deployer } = await getNamedAccounts()

  // deploy stage 1
  await deployments.fixture('stage1')

  // provide liquidity to TREE-yUSD UNI-V2 pair
  const amount = BigNumber(100).times(1e18).toFixed()
  const yUSDContract = await ethers.getContractAt('IERC20', config.reserveToken)
  const uniswapRouterContract = await ethers.getContractAt('IUniswapV2Router02', UNI_ROUTER_ADDR)
  const wethAddress = await uniswapRouterContract.WETH()
  const deadline = BigNumber(1e20).toFixed() // a loooooong time in the future
  await uniswapRouterContract.swapExactETHForTokens(0, [wethAddress, USDT_ADDR, config.reserveToken], deployer, deadline, { from: deployer, value: ethers.utils.parseEther('5'), gasLimit: 2e5 })
  const treeDeployment = await get('TREE')
  const treeContract = await ethers.getContractAt('TREE', treeDeployment.address)
  await treeContract.approve(uniswapRouterContract.address, amount, { from: deployer })
  await yUSDContract.approve(uniswapRouterContract.address, amount, { from: deployer })
  await uniswapRouterContract.addLiquidity(treeContract.address, config.reserveToken, amount, amount, 0, 0, deployer, deadline, { from: deployer, gasLimit: 3e6 })

  // deploy stage 2
  const oracleDeployment = await get('UniswapOracle')
  const oracleContract = await ethers.getContractAt('UniswapOracle', oracleDeployment.address)
  await oracleContract.init({ from: deployer })

  // wait for farming activation
  await timeTravel(config.rewardStartTimestamp - Math.floor(Date.now() / 1e3))
})

describe('TREE', () => {
  let tree

  beforeEach(async () => {
    await setupTest()
    const treeDeployment = await get('TREE')
    tree = await ethers.getContractAt('TREE', treeDeployment.address)
  })

  it('should not have owner', async () => {
    expect(await tree.owner()).to.equal(ZERO_ADDR, 'has non zero owner')
  })

  it('should have correct reserve and rebaser addresses', async () => {
    const reserveDeployment = await get('TREEReserve')
    const rebaserDeployment = await get('TREERebaser')
    expect(await tree.reserve()).to.equal(reserveDeployment.address, 'has wrong reserve address')
    expect(await tree.rebaser()).to.equal(rebaserDeployment.address, 'has wrong rebaser address')
  })
})

describe('Farming', () => {
  let tree

  beforeEach(async () => {
    await setupTest()
    const treeDeployment = await get('TREE')
    tree = await ethers.getContractAt('TREE', treeDeployment.address)
  })

  it('should give correct reward to regular pool', async () => {
    const { deployer } = await getNamedAccounts()

    // get SNX from Uniswap
    const uniswapRouterContract = await ethers.getContractAt('IUniswapV2Router02', UNI_ROUTER_ADDR)
    const wethAddress = await uniswapRouterContract.WETH()
    const deadline = BigNumber(1e20).toFixed() // a loooooong time in the future
    await uniswapRouterContract.swapExactETHForTokens(0, [wethAddress, SNX_ADDR], deployer, deadline, { from: deployer, value: ethers.utils.parseEther('1'), gasLimit: 2e5 })

    // stake SNX into forest
    const snxContract = await ethers.getContractAt('IERC20', SNX_ADDR)
    const snxBalance = await snxContract.balanceOf(deployer)
    const snxForestDeployment = await get('SNXForest')
    const snxForestContract = await ethers.getContractAt('TREERewards', snxForestDeployment.address)
    await snxContract.approve(snxForestDeployment.address, snxBalance, { from: deployer })
    await snxForestContract.stake(snxBalance, { from: deployer })

    // wait 7 days
    await timeTravel(7 * DAY)

    // withdraw SNX + reward
    await snxForestContract.exit({ from: deployer })

    // should have received all TREE in pool
    expect(await tree.balanceOf(deployer)).to.be.least(BigNumber(REG_POOL_TREES).minus(1e18).toFixed())
    expect(await tree.balanceOf(deployer)).to.be.most(BigNumber(REG_POOL_TREES).toFixed())
  })

  it('should give correct reward to LP pool', async () => {
    const { deployer } = await getNamedAccounts()

    // stake LP tokens into forest
    const uniswapFactoryContract = await ethers.getContractAt('IUniswapV2Factory', config.uniswapFactory)
    const treePairAddress = await uniswapFactoryContract.getPair(tree.address, config.reserveToken)
    const treePairContract = await ethers.getContractAt('IERC20', treePairAddress)
    const lpTokenBalance = await treePairContract.balanceOf(deployer)
    const lpRewardsDeployment = await get('LPRewards')
    const lpRewardsContract = await ethers.getContractAt('TREERewards', lpRewardsDeployment.address)
    await treePairContract.approve(lpRewardsDeployment.address, lpTokenBalance, { from: deployer })
    await lpRewardsContract.stake(lpTokenBalance, { from: deployer })

    // wait 7 days
    await timeTravel(7 * DAY)

    // withdraw LP tokens + reward
    await lpRewardsContract.exit({ from: deployer })

    // should have received all TREE in pool
    expect(await tree.balanceOf(deployer)).to.be.least(BigNumber(config.lpRewardInitial).minus(1e18).toFixed())
    expect(await tree.balanceOf(deployer)).to.be.most(BigNumber(config.lpRewardInitial).toFixed())
  })
})

describe('Rebasing', () => {
  let tree, rebaser, reserve

  beforeEach(async () => {
    await setupTest()
    const treeDeployment = await get('TREE')
    tree = await ethers.getContractAt('TREE', treeDeployment.address)
    const rebaserDeployment = await get('TREERebaser')
    rebaser = await ethers.getContractAt('TREERebaser', rebaserDeployment.address)
    const reserveDeployment = await get('TREEReserve')
    reserve = await ethers.getContractAt('TREEReserve', reserveDeployment.address)
  })

  it('should not rebase when price delta is below threshold', async () => {
    await expect(rebaser.rebase()).to.be.reverted
  })

  it('should rebase when price is above peg by threshold delta', async () => {
    const { deployer } = await getNamedAccounts()

    // purchase yUSD
    const yUSDContract = await ethers.getContractAt('IERC20', config.reserveToken)
    const uniswapRouterContract = await ethers.getContractAt('IUniswapV2Router02', UNI_ROUTER_ADDR)
    const wethAddress = await uniswapRouterContract.WETH()
    const deadline = BigNumber(1e20).toFixed() // a loooooong time in the future
    await uniswapRouterContract.swapExactETHForTokens(0, [wethAddress, USDT_ADDR, config.reserveToken], deployer, deadline, { from: deployer, value: ethers.utils.parseEther('1'), gasLimit: 3e5 })

    // sell yUSD for TREE
    const amount = BigNumber(100).times(1e18).toFixed()
    await yUSDContract.approve(UNI_ROUTER_ADDR, amount, { from: deployer })
    await uniswapRouterContract.swapExactTokensForTokens(amount, 0, [config.reserveToken, tree.address], deployer, deadline, { from: deployer, gasLimit: 3e5 })

    // wait 12 hours
    await timeTravel(12 * HOUR)

    // check TREE price and minted token amount
    const oracleDeployment = await get('UniswapOracle')
    const oracleContract = await ethers.getContractAt('UniswapOracle', oracleDeployment.address)
    await oracleContract.update()
    const price = (await oracleContract.consult(tree.address, PRECISION))
    const priceDelta = price.sub(PRECISION).mul(config.rebaseMultiplier.toString()).div(PRECISION)
    const expectedMintTreeAmount = priceDelta.mul(await tree.totalSupply()).div(PRECISION)

    // rebase
    const lpRewardsDeployment = await get('LPRewards')
    const lpRewardsTreeBalance = await tree.balanceOf(lpRewardsDeployment.address)
    await expect(rebaser.rebase({ from: deployer, gasLimit: 1e6 })).to.emit(rebaser, 'Rebase').withArgs(expectedMintTreeAmount)

    // check TREE balances
    const expectedCharityBalance = expectedMintTreeAmount.mul(config.charityCut.toString()).div(PRECISION)
    const expectedLPRewardsBalanceChange = expectedMintTreeAmount.mul(config.rewardsCut.toString()).div(PRECISION)
    const expectedReserveBalance = expectedMintTreeAmount.mul(BigNumber(PRECISION).minus(config.charityCut).minus(config.rewardsCut).toFixed()).div(PRECISION)
    const actualCharityBalance = await tree.balanceOf(config.charity)
    const actualLPRewardsBalanceChange = (await tree.balanceOf(lpRewardsDeployment.address)).sub(lpRewardsTreeBalance)
    const actualReserveBalance = await tree.balanceOf(reserve.address)
    expect(actualCharityBalance).to.be.most(expectedCharityBalance.add(1e9))
    expect(actualCharityBalance).to.be.least(expectedCharityBalance.sub(1e9))
    expect(actualLPRewardsBalanceChange).to.be.most(expectedLPRewardsBalanceChange.add(1e9))
    expect(actualLPRewardsBalanceChange).to.be.least(expectedLPRewardsBalanceChange.sub(1e9))
    expect(actualReserveBalance).to.be.most(expectedReserveBalance.add(1e9))
    expect(actualReserveBalance).to.be.least(expectedReserveBalance.sub(1e9))
  })
})

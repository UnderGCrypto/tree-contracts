module.exports = async ({ ethers, getNamedAccounts, deployments, getChainId }) => {
  const { get, log } = deployments
  const { deployer } = await getNamedAccounts()

  const rebaserDeployment = await get('TREERebaser')
  const reserveDeployment = await get('TREEReserve')
  const reserveContract = await ethers.getContractAt('TREEReserve', reserveDeployment.address)
  const reserveRebaserAddress = await reserveContract.rebaser()
  if (reserveRebaserAddress === '0x0000000000000000000000000000000000000000') {
    await reserveContract.initContracts(rebaserDeployment.address, { from: deployer })
    log('Initialized TREEReserve')
  }
}
module.exports.tags = ['TREEReserve-init', 'stage1']
module.exports.dependencies = ['TREEReserve', 'TREERebaser']
module.exports.runAtTheEnd = true

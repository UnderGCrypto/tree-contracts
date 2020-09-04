// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.6.6;

/**
 *Submitted for verification at Etherscan.io on 2020-07-17
 */

/*
   ____            __   __        __   _
  / __/__ __ ___  / /_ / /  ___  / /_ (_)__ __
 _\ \ / // // _ \/ __// _ \/ -_)/ __// / \ \ /
/___/ \_, //_//_/\__//_//_/\__/ \__//_/ /_\_\
     /___/

* Synthetix: TREERewards.sol
*
* Docs: https://docs.synthetix.io/
*
*
* MIT License
* ===========
*
* Copyright (c) 2020 Synthetix
*
* Permission is hereby granted, free of charge, to any person obtaining a copy
* of this software and associated documentation files (the "Software"), to deal
* in the Software without restriction, including without limitation the rights
* to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
* copies of the Software, and to permit persons to whom the Software is
* furnished to do so, subject to the following conditions:
*
* The above copyright notice and this permission notice shall be included in all
* copies or substantial portions of the Software.
*
* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
* IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
* FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
* AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, TREEAGES OR OTHER
* LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
* OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
*/

import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

abstract contract IRewardDistributionRecipient is Ownable {
  address public rewardDistribution;

  function notifyRewardAmount(uint256 reward) external virtual;

  modifier onlyRewardDistribution() {
    require(
      _msgSender() == rewardDistribution,
      "Caller is not reward distribution"
    );
    _;
  }

  function setRewardDistribution(address _rewardDistribution)
    external
    onlyOwner
  {
    require(_rewardDistribution != address(0), "0 input");
    rewardDistribution = _rewardDistribution;
  }
}

contract LPTokenWrapper {
  using SafeMath for uint256;
  using SafeERC20 for IERC20;

  IERC20 public stakeToken;

  uint256 private _totalSupply;
  mapping(address => uint256) private _balances;

  constructor(address _stakeToken) public {
    stakeToken = IERC20(_stakeToken);
  }

  function totalSupply() public view returns (uint256) {
    return _totalSupply;
  }

  function balanceOf(address account) public view returns (uint256) {
    return _balances[account];
  }

  function stake(uint256 amount) public virtual {
    _totalSupply = _totalSupply.add(amount);
    _balances[msg.sender] = _balances[msg.sender].add(amount);
    stakeToken.safeTransferFrom(msg.sender, address(this), amount);
  }

  function withdraw(uint256 amount) public virtual {
    _totalSupply = _totalSupply.sub(amount);
    _balances[msg.sender] = _balances[msg.sender].sub(amount);
    stakeToken.safeTransfer(msg.sender, amount);
  }
}

contract TREERewards is LPTokenWrapper, IRewardDistributionRecipient {
  IERC20 public rewardToken;
  uint256 public constant DURATION = 7 days;

  uint256 public starttime;
  uint256 public periodFinish = 0;
  uint256 public rewardRate = 0;
  uint256 public lastUpdateTime;
  uint256 public rewardPerTokenStored;
  mapping(address => uint256) public userRewardPerTokenPaid;
  mapping(address => uint256) public rewards;

  event RewardAdded(uint256 reward);
  event Staked(address indexed user, uint256 amount);
  event Withdrawn(address indexed user, uint256 amount);
  event RewardPaid(address indexed user, uint256 reward);

  modifier checkStart() {
    require(block.timestamp >= starttime, "not start");
    _;
  }

  modifier updateReward(address account) {
    rewardPerTokenStored = rewardPerToken();
    lastUpdateTime = lastTimeRewardApplicable();
    if (account != address(0)) {
      rewards[account] = earned(account);
      userRewardPerTokenPaid[account] = rewardPerTokenStored;
    }
    _;
  }

  constructor(
    uint256 _starttime,
    address _stakeToken,
    address _rewardToken
  ) public LPTokenWrapper(_stakeToken) {
    starttime = _starttime;
    rewardToken = IERC20(_rewardToken);
  }

  function lastTimeRewardApplicable() public view returns (uint256) {
    return Math.min(block.timestamp, periodFinish);
  }

  function rewardPerToken() public view returns (uint256) {
    if (totalSupply() == 0) {
      return rewardPerTokenStored;
    }
    return
      rewardPerTokenStored.add(
        lastTimeRewardApplicable()
          .sub(lastUpdateTime)
          .mul(rewardRate)
          .mul(1e18)
          .div(totalSupply())
      );
  }

  function earned(address account) public view returns (uint256) {
    return
      balanceOf(account)
        .mul(rewardPerToken().sub(userRewardPerTokenPaid[account]))
        .div(1e18)
        .add(rewards[account]);
  }

  // stake visibility is public as overriding LPTokenWrapper's stake() function
  function stake(uint256 amount)
    public
    override
    updateReward(msg.sender)
    checkStart
  {
    require(amount > 0, "Cannot stake 0");
    super.stake(amount);
    emit Staked(msg.sender, amount);
  }

  function withdraw(uint256 amount)
    public
    override
    updateReward(msg.sender)
    checkStart
  {
    require(amount > 0, "Cannot withdraw 0");
    super.withdraw(amount);
    emit Withdrawn(msg.sender, amount);
  }

  function exit() external {
    withdraw(balanceOf(msg.sender));
    getReward();
  }

  function getReward() public updateReward(msg.sender) checkStart {
    uint256 reward = earned(msg.sender);
    if (reward > 0) {
      rewards[msg.sender] = 0;
      rewardToken.safeTransfer(msg.sender, reward);
      emit RewardPaid(msg.sender, reward);
    }
  }

  function notifyRewardAmount(uint256 reward)
    external
    override
    onlyRewardDistribution
    updateReward(address(0))
  {
    if (block.timestamp > starttime) {
      if (block.timestamp >= periodFinish) {
        rewardRate = reward.div(DURATION);
      } else {
        uint256 remaining = periodFinish.sub(block.timestamp);
        uint256 leftover = remaining.mul(rewardRate);
        rewardRate = reward.add(leftover).div(DURATION);
      }
      lastUpdateTime = block.timestamp;
      periodFinish = block.timestamp.add(DURATION);
      emit RewardAdded(reward);
    } else {
      rewardRate = reward.div(DURATION);
      lastUpdateTime = starttime;
      periodFinish = starttime.add(DURATION);
      emit RewardAdded(reward);
    }
  }
}